'use strict'

const { expandSecretKeyCandidates } = require('./utils')

/**
 * SqsConsumer long-polls an SQS queue fed by EventBridge (AWS Secrets Manager
 * CloudTrail events, usually via SNS) and triggers an immediate re-sync of the
 * ExternalSecrets referencing a changed secret. Messages are always deleted
 * after processing — matched or not — because unmatched events are the common
 * case in multi-cluster accounts and redelivery cannot fix a parse failure;
 * the regular poller remains the correctness backstop for missed events.
 */
class SqsConsumer {
  /**
   * Create SQS consumer.
   * @param {string} queueUrl - URL of the SQS queue to long-poll.
   * @param {Object} sqsClient - AWS SDK v3 SQS client.
   * @param {Object} daemon - Daemon instance, used to look up pollers by secret name.
   * @param {Object} logger - Logger for logging stuff.
   * @param {Object} metrics - Metrics client.
   * @param {number} waitTimeSeconds - Long-poll wait time.
   * @param {number} maxNumberOfMessages - Max messages per receive.
   * @param {number} initialBackoffMs - First retry delay after a receive error.
   * @param {number} maxBackoffMs - Cap for the exponential retry delay.
   */
  constructor ({
    queueUrl,
    sqsClient,
    daemon,
    logger,
    metrics,
    waitTimeSeconds = 20,
    maxNumberOfMessages = 10,
    initialBackoffMs = 1000,
    maxBackoffMs = 60000,
    minSyncIntervalMilliseconds = 10000
  }) {
    this._queueUrl = queueUrl
    this._sqs = sqsClient
    this._daemon = daemon
    this._logger = logger
    this._metrics = metrics
    this._waitTimeSeconds = waitTimeSeconds
    this._maxNumberOfMessages = maxNumberOfMessages
    this._initialBackoffMs = initialBackoffMs
    this._maxBackoffMs = maxBackoffMs

    this._minSyncIntervalMilliseconds = minSyncIntervalMilliseconds
    this._running = false
    this._stopping = false
    this._loopPromise = null
    this._abortController = null
    this._backoffTimeout = null
    this._backoffResolve = null
    this._degraded = false
    // Rate floor for event-triggered syncs, keyed by namespace/name (stable
    // across poller recreations, which per-poller state would not survive).
    // Without this, account-wide secret churn on the shared queue has no
    // ceiling and amplifies into kube-apiserver load.
    this._lastTriggeredAt = new Map()
    // Trailing-edge timers: a suppressed event is deferred to the floor's
    // expiry rather than dropped, so a burst that ENDS inside the window
    // still converges without waiting for the fallback poll. One timer per
    // ExternalSecret at most.
    this._deferredSyncs = new Map()
  }

  /**
   * Start the long-poll loop. Idempotent; the loop is intentionally not
   * awaited by callers (it runs until stop()).
   * @returns {Object} SqsConsumer instance.
   */
  start () {
    // Guard both the running state and an in-flight stop(): restarting while
    // the old loop drains would leave two concurrent receive loops and a
    // stop() that never resolves.
    if (this._running || this._stopping) return this

    this._logger.info(`starting sqs consumer for queue ${this._queueUrl}`)
    this._running = true
    this._metrics.setSqsConsumerRunning(1)
    // The loop must never take the process down or die silently: without
    // this catch an escaped error is an unhandled rejection, and a dead loop
    // would quietly degrade event-driven sync to the slow fallback poll.
    this._loopPromise = this._run().catch((err) => {
      this._logger.error(err, 'sqs consumer loop died, event-driven sync is DISABLED until restart')
    }).finally(() => {
      this._running = false
      this._metrics.setSqsConsumerRunning(0)
    })

    return this
  }

  /**
   * Stop the loop, aborting any in-flight receive or backoff sleep.
   * Safe to call if start() was never called.
   * @returns {Promise} resolves when the loop has exited.
   */
  async stop () {
    if (!this._running) return

    this._logger.info('stopping sqs consumer')
    this._running = false
    this._stopping = true

    if (this._abortController) {
      this._abortController.abort()
    }
    if (this._backoffTimeout) {
      clearTimeout(this._backoffTimeout)
      this._backoffTimeout = null
      if (this._backoffResolve) {
        this._backoffResolve()
        this._backoffResolve = null
      }
    }
    this._deferredSyncs.forEach((timer) => clearTimeout(timer))
    this._deferredSyncs.clear()

    try {
      await this._loopPromise
    } finally {
      this._stopping = false
    }
  }

  async _run () {
    let backoffMs = this._initialBackoffMs

    while (this._running) {
      this._abortController = new AbortController()

      let response
      try {
        response = await this._sqs.receiveMessage({
          QueueUrl: this._queueUrl,
          WaitTimeSeconds: this._waitTimeSeconds,
          MaxNumberOfMessages: this._maxNumberOfMessages
        }, { abortSignal: this._abortController.signal })
      } catch (err) {
        if (!this._running || err.name === 'AbortError') break

        this._metrics.observeSqsReceiveError()
        // A persistently failing receive (bad IAM, wrong URL/region, proxy)
        // keeps this loop alive forever, so "running" alone would lie to the
        // operator. Once backoff maxes out, report the consumer as down.
        if (backoffMs >= this._maxBackoffMs && !this._degraded) {
          this._degraded = true
          this._metrics.setSqsConsumerRunning(0)
          this._logger.error('sqs receive has failed continuously, reporting consumer as down (event-driven sync is not working)')
        }
        this._logger.error(err, 'failure while receiving sqs messages, backing off %d ms', backoffMs)
        await this._sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, this._maxBackoffMs)
        continue
      }

      backoffMs = this._initialBackoffMs
      if (this._degraded) {
        this._degraded = false
        this._metrics.setSqsConsumerRunning(1)
        this._logger.info('sqs receive recovered, consumer running again')
      }

      const messages = (response && response.Messages) || []
      for (const message of messages) {
        this._metrics.observeSqsMessageReceived()

        try {
          this._handleMessage(message)
        } catch (err) {
          this._logger.error(err, 'failure while handling sqs message')
        }

        try {
          // Abortable so shutdown isn't extended by SDK retries; an aborted
          // delete just means the message is redelivered and ignored later.
          await this._sqs.deleteMessage({
            QueueUrl: this._queueUrl,
            ReceiptHandle: message.ReceiptHandle
          }, { abortSignal: this._abortController.signal })
        } catch (err) {
          if (!this._running || err.name === 'AbortError') return
          this._logger.error(err, 'failure while deleting sqs message')
        }
      }
    }
  }

  _handleMessage (message) {
    let parsed
    try {
      parsed = JSON.parse(message.Body)
    } catch (err) {
      this._logger.debug('skipping unparseable sqs message body')
      return
    }

    // Unwrap the SNS envelope unless raw message delivery is enabled.
    let event = parsed
    if (parsed && parsed.Type === 'Notification' && typeof parsed.Message === 'string') {
      try {
        event = JSON.parse(parsed.Message)
      } catch (err) {
        this._logger.debug('skipping sns notification with unparseable message')
        return
      }
    }

    // Defense in depth on top of the queue policy: drop events that declare
    // a source other than Secrets Manager. A bare CloudTrail detail carries
    // no source field and is still accepted.
    if (event && typeof event.source === 'string' && event.source !== 'aws.secretsmanager') {
      this._logger.debug('sqs message source %s is not aws.secretsmanager, ignoring', event.source)
      return
    }

    // Tolerate a bare CloudTrail detail as well as a full EventBridge event.
    const detail = (event && event.detail) || event
    if (!detail || typeof detail !== 'object') return

    // Secret ids appear in different places depending on the event shape:
    // - native "Secret Label Updated": detail.name (friendly name) and the
    //   event's top-level resources[] (suffixed ARN)
    // - CloudTrail API-call events: detail.requestParameters.secretId
    //   (name or ARN) and detail.responseElements.arn — some events use
    //   the aRN capitalization instead
    // - CloudTrail service events (e.g. RotationSucceeded):
    //   detail.additionalEventData.SecretId
    const ids = []
    const pushString = (value) => {
      if (typeof value === 'string' && value !== '') ids.push(value)
    }

    pushString(detail.name)
    if (event && Array.isArray(event.resources)) {
      event.resources.forEach(pushString)
    }
    if (detail.requestParameters) {
      pushString(detail.requestParameters.secretId)
    }
    if (detail.responseElements) {
      pushString(detail.responseElements.arn)
      pushString(detail.responseElements.aRN)
    }
    if (detail.additionalEventData) {
      pushString(detail.additionalEventData.SecretId)
    }

    if (ids.length === 0) {
      this._logger.debug('sqs message carried no secret id, ignoring')
      return
    }

    const matched = new Set()
    ids.forEach((id) => {
      expandSecretKeyCandidates(id).forEach((candidate) => {
        this._daemon.getPollersForSecretName(candidate).forEach((poller) => matched.add(poller))
      })
    })

    const now = Date.now()
    this._pruneTriggerHistory(now)

    const candidates = new Set()
    ids.forEach((id) => {
      expandSecretKeyCandidates(id).forEach((candidate) => candidates.add(candidate))
    })

    matched.forEach((poller) => {
      // Rate floor: at most one event-triggered sync per ExternalSecret per
      // minSyncInterval. A suppressed event is deferred to the window's end
      // (trailing edge) so the last event of a burst still lands.
      const rateKey = `${poller.namespace}/${poller.name}`
      const last = this._lastTriggeredAt.get(rateKey)
      const elapsed = last === undefined ? Infinity : now - last
      if (elapsed < this._minSyncIntervalMilliseconds) {
        this._deferSync(rateKey, [...candidates], this._minSyncIntervalMilliseconds - elapsed)
        return
      }
      this._triggerPoller(rateKey, poller, now)
    })

    this._logger.debug('sqs event for %s matched %d externalsecret(s)', ids[0], matched.size)
  }

  _triggerPoller (rateKey, poller, now) {
    this._lastTriggeredAt.set(rateKey, now)
    poller.triggerSync()
    this._metrics.observeEventTriggeredSync({
      name: poller.name,
      namespace: poller.namespace
    })
  }

  /**
   * Defer a suppressed sync to the rate-floor window's end. The poller is
   * re-resolved through the daemon at fire time — the instance that matched
   * now may have been recreated (or removed) by then.
   */
  _deferSync (rateKey, candidateNames, delayMs) {
    if (this._deferredSyncs.has(rateKey)) return

    this._logger.debug('deferring event sync for %s by %d ms (rate floor)', rateKey, delayMs)
    const timer = setTimeout(() => {
      this._deferredSyncs.delete(rateKey)
      if (!this._running) return

      const live = new Set()
      candidateNames.forEach((candidate) => {
        this._daemon.getPollersForSecretName(candidate).forEach((poller) => live.add(poller))
      })
      live.forEach((poller) => {
        if (`${poller.namespace}/${poller.name}` !== rateKey) return
        this._triggerPoller(rateKey, poller, Date.now())
      })
    }, delayMs)
    this._deferredSyncs.set(rateKey, timer)
  }

  /**
   * Drop rate-floor entries old enough to be no-ops, so the map stays
   * bounded even though deleted ExternalSecrets never notify the consumer.
   */
  _pruneTriggerHistory (now) {
    if (this._lastTriggeredAt.size <= 1024) return
    for (const [key, ts] of this._lastTriggeredAt) {
      if (now - ts >= this._minSyncIntervalMilliseconds) {
        this._lastTriggeredAt.delete(key)
      }
    }
  }

  _sleep (ms) {
    return new Promise((resolve) => {
      this._backoffResolve = resolve
      this._backoffTimeout = setTimeout(() => {
        this._backoffTimeout = null
        this._backoffResolve = null
        resolve()
      }, ms)
    })
  }
}

module.exports = SqsConsumer
