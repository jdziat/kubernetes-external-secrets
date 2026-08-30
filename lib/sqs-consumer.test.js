'use strict'

const { expect } = require('chai')
const sinon = require('sinon')

const SqsConsumer = require('./sqs-consumer')

describe('SqsConsumer', () => {
  let sqsMock
  let daemonMock
  let loggerMock
  let metricsMock
  let pollerMock

  const queueUrl = 'https://sqs.us-west-2.amazonaws.com/123456789012/kes-events'

  const eventBody = (secretId) => JSON.stringify({
    source: 'aws.secretsmanager',
    'detail-type': 'AWS API Call via CloudTrail',
    detail: {
      eventName: 'PutSecretValue',
      requestParameters: { secretId }
    }
  })

  const makeConsumer = (opts = {}) => new SqsConsumer({
    queueUrl,
    sqsClient: sqsMock,
    daemon: daemonMock,
    logger: loggerMock,
    metrics: metricsMock,
    waitTimeSeconds: 0,
    initialBackoffMs: 1000,
    maxBackoffMs: 4000,
    ...opts
  })

  // Resolve one batch of messages, then park until stop() aborts.
  const receiveOnceThenBlock = (messages) => {
    let calls = 0
    sqsMock.receiveMessage = sinon.stub().callsFake((params, { abortSignal }) => {
      calls += 1
      if (calls === 1) return Promise.resolve({ Messages: messages })
      return new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
  }

  beforeEach(() => {
    pollerMock = {
      name: 'fakeSecretName',
      namespace: 'fakeNamespace',
      triggerSync: sinon.stub()
    }

    sqsMock = {
      receiveMessage: sinon.stub().resolves({ Messages: [] }),
      deleteMessage: sinon.stub().resolves({})
    }

    daemonMock = {
      getPollersForSecretName: sinon.stub().returns([])
    }

    loggerMock = {
      info: sinon.stub(),
      debug: sinon.stub(),
      error: sinon.stub()
    }

    metricsMock = {
      observeSqsMessageReceived: sinon.stub(),
      observeSqsReceiveError: sinon.stub(),
      observeEventTriggeredSync: sinon.stub(),
      setSqsConsumerRunning: sinon.stub()
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('triggers sync on matching pollers and deletes the message', async () => {
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    receiveOnceThenBlock([{ Body: eventBody('demo/credentials'), ReceiptHandle: 'rh-1' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
    expect(metricsMock.observeSqsMessageReceived.calledOnce).to.equal(true)
    expect(metricsMock.observeEventTriggeredSync.calledWith({
      name: 'fakeSecretName',
      namespace: 'fakeNamespace'
    })).to.equal(true)
    expect(sqsMock.deleteMessage.calledWith({
      QueueUrl: queueUrl,
      ReceiptHandle: 'rh-1'
    })).to.equal(true)
  })

  it('unwraps an SNS notification envelope', async () => {
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    const snsBody = JSON.stringify({
      Type: 'Notification',
      Message: eventBody('demo/credentials')
    })
    receiveOnceThenBlock([{ Body: snsBody, ReceiptHandle: 'rh-2' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
  })

  it('matches the native Secret Label Updated event (verbatim AWS example shape)', async () => {
    daemonMock.getPollersForSecretName.withArgs('mySecret').returns([pollerMock])
    // Structure taken verbatim from the AWS docs example for this event.
    const body = JSON.stringify({
      version: '0',
      id: '6a7e8feb-b491-4cf7-a9f1-bf3703467718',
      'detail-type': 'Secret Label Updated',
      source: 'aws.secretsmanager',
      account: '012345678901',
      time: '2024-02-06T16:43:48Z',
      region: 'us-west-2',
      resources: [
        'arn:aws:secretsmanager:us-west-2:012345678901:secret:mySecret-a1b2c3'
      ],
      detail: {
        name: 'mySecret',
        labelUpdated: 'AWSCURRENT',
        versionId: 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111'
      }
    })
    receiveOnceThenBlock([{ Body: body, ReceiptHandle: 'rh-native' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
  })

  it('matches a CloudTrail service event via additionalEventData.SecretId', async () => {
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    const body = JSON.stringify({
      source: 'aws.secretsmanager',
      'detail-type': 'AWS Service Event via CloudTrail',
      detail: {
        eventName: 'RotationSucceeded',
        additionalEventData: {
          SecretId: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:demo/credentials-Ab12Cd'
        }
      }
    })
    receiveOnceThenBlock([{ Body: body, ReceiptHandle: 'rh-svc' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
  })

  it('matches the aRN capitalization in responseElements', async () => {
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    const body = JSON.stringify({
      detail: {
        responseElements: {
          aRN: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:demo/credentials-Ab12Cd'
        }
      }
    })
    receiveOnceThenBlock([{ Body: body, ReceiptHandle: 'rh-arn' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
  })

  it('ignores events from other sources', async () => {
    daemonMock.getPollersForSecretName.returns([pollerMock])
    const body = JSON.stringify({
      source: 'aws.ec2',
      detail: {
        requestParameters: { secretId: 'demo/credentials' }
      }
    })
    receiveOnceThenBlock([{ Body: body, ReceiptHandle: 'rh-foreign' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.called).to.equal(false)
    expect(sqsMock.deleteMessage.calledOnce).to.equal(true)
  })

  it('matches on responseElements.arn when secretId is absent', async () => {
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    const body = JSON.stringify({
      detail: {
        responseElements: {
          arn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:demo/credentials-Ab12Cd'
        }
      }
    })
    receiveOnceThenBlock([{ Body: body, ReceiptHandle: 'rh-3' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
  })

  it('triggers a poller only once when matched via multiple candidates', async () => {
    daemonMock.getPollersForSecretName.returns([pollerMock])
    receiveOnceThenBlock([{ Body: eventBody('arn:aws:secretsmanager:us-west-2:123456789012:secret:demo/credentials-Ab1234'), ReceiptHandle: 'rh-4' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
  })

  it('deletes an unparseable message without throwing', async () => {
    receiveOnceThenBlock([{ Body: 'not json', ReceiptHandle: 'rh-5' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(sqsMock.deleteMessage.calledOnce).to.equal(true)
    expect(pollerMock.triggerSync.called).to.equal(false)
  })

  it('deletes a non-matching message without triggering', async () => {
    receiveOnceThenBlock([{ Body: eventBody('other/secret'), ReceiptHandle: 'rh-6' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(sqsMock.deleteMessage.calledOnce).to.equal(true)
    expect(pollerMock.triggerSync.called).to.equal(false)
  })

  it('backs off exponentially on receive errors and recovers', async () => {
    const clock = sinon.useFakeTimers()
    let calls = 0
    let sawSuccess
    const successSeen = new Promise((resolve) => { sawSuccess = resolve })
    sqsMock.receiveMessage = sinon.stub().callsFake((params, { abortSignal }) => {
      calls += 1
      if (calls <= 2) return Promise.reject(new Error('boom'))
      sawSuccess()
      return new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const consumer = makeConsumer()
    consumer.start()

    // first failure -> 1000ms backoff, second failure -> 2000ms backoff
    await clock.tickAsync(1000)
    await clock.tickAsync(2000)
    await successSeen

    expect(metricsMock.observeSqsReceiveError.callCount).to.equal(2)
    expect(sqsMock.receiveMessage.callCount).to.equal(3)

    const stopPromise = consumer.stop()
    await clock.runAllAsync()
    await stopPromise
    clock.restore()
  })

  it('stop aborts an in-flight receive and exits the loop', async () => {
    let armed
    const receiveStarted = new Promise((resolve) => { armed = resolve })
    sqsMock.receiveMessage = sinon.stub().callsFake((params, { abortSignal }) => {
      armed()
      return new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const consumer = makeConsumer()
    consumer.start()
    await receiveStarted
    await consumer.stop()

    expect(sqsMock.receiveMessage.calledOnce).to.equal(true)
    expect(metricsMock.observeSqsReceiveError.called).to.equal(false)
  })

  it('is safe to stop before start', async () => {
    const consumer = makeConsumer()
    await consumer.stop()
  })

  it('survives a loop crash: logs, marks the consumer gauge down, no unhandled rejection', async () => {
    // observeSqsMessageReceived sits outside the per-message try/catch, so a
    // throw there escapes _run — the start() catch must contain it.
    metricsMock.observeSqsMessageReceived = sinon.stub().throws(new Error('boom'))
    receiveOnceThenBlock([{ Body: eventBody('demo/credentials'), ReceiptHandle: 'rh-crash' }])

    const consumer = makeConsumer()
    consumer.start()
    await consumer._loopPromise

    expect(loggerMock.error.calledWithMatch(sinon.match.instanceOf(Error), sinon.match(/consumer loop died/))).to.equal(true)
    expect(metricsMock.setSqsConsumerRunning.firstCall.args).to.deep.equal([1])
    expect(metricsMock.setSqsConsumerRunning.lastCall.args).to.deep.equal([0])
    expect(consumer._running).to.equal(false)
  })

  it('rate-limits event syncs per ExternalSecret within minSyncInterval', async () => {
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    receiveOnceThenBlock([
      { Body: eventBody('demo/credentials'), ReceiptHandle: 'rh-r1' },
      { Body: eventBody('demo/credentials'), ReceiptHandle: 'rh-r2' }
    ])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
    // both messages are still consumed and deleted
    expect(sqsMock.deleteMessage.calledTwice).to.equal(true)
  })

  it('does not rate-limit distinct ExternalSecrets', async () => {
    const otherPoller = { name: 'other', namespace: 'ns2', triggerSync: sinon.stub() }
    daemonMock.getPollersForSecretName.withArgs('demo/credentials').returns([pollerMock])
    daemonMock.getPollersForSecretName.withArgs('demo/other').returns([otherPoller])
    receiveOnceThenBlock([
      { Body: eventBody('demo/credentials'), ReceiptHandle: 'rh-d1' },
      { Body: eventBody('demo/other'), ReceiptHandle: 'rh-d2' }
    ])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(pollerMock.triggerSync.calledOnce).to.equal(true)
    expect(otherPoller.triggerSync.calledOnce).to.equal(true)
  })

  it('reports the gauge down on continuous receive failure and up on recovery', async () => {
    const clock = sinon.useFakeTimers()
    let calls = 0
    let sawPostRecoveryCall
    const postRecoverySeen = new Promise((resolve) => { sawPostRecoveryCall = resolve })
    sqsMock.receiveMessage = sinon.stub().callsFake((params, { abortSignal }) => {
      calls += 1
      // backoff starts at maxBackoffMs so the first failure counts as continuous
      if (calls === 1) return Promise.reject(new Error('AccessDenied'))
      if (calls === 2) return Promise.resolve({ Messages: [] }) // recovery
      sawPostRecoveryCall()
      return new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const consumer = makeConsumer({ initialBackoffMs: 4000, maxBackoffMs: 4000 })
    consumer.start()
    await clock.tickAsync(4000)
    await postRecoverySeen

    // Checked before stop(), which legitimately zeroes the gauge again.
    const gaugeValues = metricsMock.setSqsConsumerRunning.getCalls().map((c) => c.args[0])
    expect(gaugeValues).to.deep.equal([1, 0, 1]) // started, degraded, recovered

    const stopPromise = consumer.stop()
    await clock.runAllAsync()
    await stopPromise
    clock.restore()
  })

  it('reports the consumer gauge up on start and down on stop', async () => {
    receiveOnceThenBlock([])

    const consumer = makeConsumer()
    consumer.start()
    await consumer.stop()

    expect(metricsMock.setSqsConsumerRunning.firstCall.args).to.deep.equal([1])
    expect(metricsMock.setSqsConsumerRunning.lastCall.args).to.deep.equal([0])
  })

  it('start is idempotent', async () => {
    let armed
    const receiveStarted = new Promise((resolve) => { armed = resolve })
    sqsMock.receiveMessage = sinon.stub().callsFake((params, { abortSignal }) => {
      armed()
      return new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const consumer = makeConsumer()
    consumer.start()
    consumer.start()
    await receiveStarted
    await consumer.stop()

    expect(sqsMock.receiveMessage.calledOnce).to.equal(true)
  })
})
