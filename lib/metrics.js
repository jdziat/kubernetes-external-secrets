'use strict'

const Prometheus = require('prom-client')

/** Metrics class. */
class Metrics {
  /**
   * Create Metrics object
   */
  constructor ({ registry }) {
    this._registry = registry
    this._syncCallsCount = new Prometheus.Counter({
      name: 'kubernetes_external_secrets_sync_calls_count',
      help: 'Number of sync operations',
      labelNames: ['name', 'namespace', 'backend', 'status'],
      registers: [registry]
    })
    this._syncCalls = new Prometheus.Counter({
      name: 'sync_calls',
      help: '(Deprecated since 0.6.1, please use kubernetes_external_secrets_sync_calls_count) Number of sync operations',
      labelNames: ['name', 'namespace', 'backend', 'status'],
      registers: [registry]
    })
    this._lastSyncCallState = new Prometheus.Gauge({
      name: 'kubernetes_external_secrets_last_sync_call_state',
      help: 'State of last sync call of external secret. Value -1 if the last sync was a failure, 1 otherwise',
      labelNames: ['name', 'namespace', 'backend'],
      registers: [registry]
    })
    this._lastState = new Prometheus.Gauge({
      name: 'last_state',
      help: '(Deprecated since 0.6.1, please use kubernetes_external_secrets_last_sync_call_state) Value -1 if the last sync was a failure, 1 otherwise',
      labelNames: ['name', 'namespace', 'backend'],
      registers: [registry]
    })
    this._sqsMessagesReceived = new Prometheus.Counter({
      name: 'kubernetes_external_secrets_sqs_messages_received_total',
      help: 'Number of messages received from the event-driven sync SQS queue',
      registers: [registry]
    })
    this._sqsReceiveErrors = new Prometheus.Counter({
      name: 'kubernetes_external_secrets_sqs_receive_errors_total',
      help: 'Number of failed SQS ReceiveMessage calls for event-driven sync',
      registers: [registry]
    })
    this._eventTriggeredSyncs = new Prometheus.Counter({
      name: 'kubernetes_external_secrets_event_triggered_syncs_total',
      help: 'Number of syncs triggered by Secrets Manager change events',
      labelNames: ['name', 'namespace'],
      registers: [registry]
    })
    this._sqsConsumerRunning = new Prometheus.Gauge({
      name: 'kubernetes_external_secrets_sqs_consumer_running',
      help: 'Whether the event-driven sync SQS consumer loop is running (1) or stopped/dead (0)',
      registers: [registry]
    })
  }

  /**
   * Record whether the SQS consumer loop is alive; alert on 0 when
   * event-driven sync is expected to be enabled.
   * @param {Number} value - 1 if running, 0 otherwise
   */
  setSqsConsumerRunning (value) {
    this._sqsConsumerRunning.set(value)
  }

  /** Observe a message received from the event-driven sync SQS queue. */
  observeSqsMessageReceived () {
    this._sqsMessagesReceived.inc()
  }

  /** Observe a failed SQS ReceiveMessage call. */
  observeSqsReceiveError () {
    this._sqsReceiveErrors.inc()
  }

  /**
   * Observe a sync triggered by a Secrets Manager change event.
   * @param {String} name - the name of the externalSecret
   * @param {String} namespace - the namespace of the externalSecret
   */
  observeEventTriggeredSync ({ name, namespace }) {
    this._eventTriggeredSyncs.inc({ name, namespace })
  }

  /**
   * Observe the result a sync process
   * @param {String} name - the name of the externalSecret
   * @param {String} namespace - the namespace of the externalSecret
   * @param {String} backend - the backend used to fetch the externalSecret
   * @param {String} status - the result of the sync process: error|success
   */
  observeSync ({ name, namespace, backend, status }) {
    this._syncCallsCount.inc({
      name,
      namespace,
      backend,
      status
    })
    this._syncCalls.inc({
      name,
      namespace,
      backend,
      status
    })
    if (status === 'success') {
      this._lastSyncCallState.set({
        name,
        namespace,
        backend
      }, 1)
      this._lastState.set({
        name,
        namespace,
        backend
      }, 1)
    } else {
      this._lastSyncCallState.set({
        name,
        namespace,
        backend
      }, -1)
      this._lastState.set({
        name,
        namespace,
        backend
      }, -1)
    }
  }
}

module.exports = Metrics
