'use strict'

const { expect } = require('chai')
const sinon = require('sinon')

const Daemon = require('./daemon')

describe('Daemon', () => {
  let daemon
  let loggerMock
  let pollerMock
  let pollerFactory

  beforeEach(() => {
    loggerMock = sinon.mock()
    loggerMock.info = sinon.stub()
    loggerMock.warn = sinon.stub()
    loggerMock.debug = sinon.stub()

    pollerMock = sinon.mock()
    pollerMock.start = sinon.stub().returns(pollerMock)
    pollerMock.stop = sinon.stub().returns(pollerMock)

    pollerFactory = sinon.mock()
    pollerFactory.createPoller = sinon.stub().returns(pollerMock)

    daemon = new Daemon({
      logger: loggerMock,
      pollerFactory
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('starts new pollers for external secrets', async () => {
    const fakeExternalSecretEvents = (async function * () {
      yield {
        type: 'ADDED',
        object: {
          metadata: {
            name: 'foo',
            namespace: 'foo',
            resourceVersion: '1'
          },
          spec: {}
        }
      }
    }())
    daemon._externalSecretEvents = fakeExternalSecretEvents

    await daemon.start()
    daemon.stop()

    expect(pollerMock.start.called).to.equal(true)
    expect(pollerMock.stop.called).to.equal(true)
  })

  it('tries to remove existing poller on ADDED events', async () => {
    const fakeExternalSecretEvents = (async function * () {
      yield {
        type: 'ADDED',
        object: {
          metadata: {
            name: 'foo',
            namespace: 'foo',
            uid: 'test-id'
          }
        }
      }
    }())

    daemon._externalSecretEvents = fakeExternalSecretEvents
    daemon._addPoller = sinon.mock()
    daemon._removePoller = sinon.mock()

    await daemon.start()
    daemon.stop()

    expect(daemon._addPoller.called).to.equal(true)
    expect(daemon._removePoller.calledWith('test-id')).to.equal(true)
  })

  it('tries to remove existing poller on MODIFIED event', async () => {
    const fakeExternalSecretEvents = (async function * () {
      yield {
        type: 'MODIFIED',
        object: {
          metadata: {
            name: 'foo',
            namespace: 'foo',
            uid: 'test-id'
          }
        }
      }
    }())

    daemon._externalSecretEvents = fakeExternalSecretEvents
    daemon._addPoller = sinon.mock()
    daemon._removePoller = sinon.mock()

    await daemon.start()
    daemon.stop()

    expect(daemon._addPoller.called).to.equal(true)
    expect(daemon._removePoller.calledWith('test-id')).to.equal(true)
  })

  it('manage externalsecrets with unmatched controller id and instance id', async () => {
    const fakeExternalSecretEvents = (async function * () {
      yield {
        type: 'ADDED',
        object: {
          metadata: {
            name: 'foo',
            namespace: 'foo',
            uid: 'test-id'
          },
          spec: {
            controllerId: 'instance01'
          }
        }
      }
    }())

    daemon._instanceId = 'instance01'
    daemon._externalSecretEvents = fakeExternalSecretEvents
    daemon._addPoller = sinon.mock()
    daemon._removePoller = sinon.mock()

    await daemon.start()
    daemon.stop()

    expect(daemon._addPoller.called).to.equal(true)
    expect(daemon._removePoller.calledWith('test-id')).to.equal(true)
  })

  it('do not manage externalsecrets with unmatched controller id and instance id', async () => {
    const fakeExternalSecretEvents = (async function * () {
      yield {
        type: 'ADDED',
        object: {
          metadata: {
            name: 'foo',
            namespace: 'foo',
            uid: 'test-id'
          },
          spec: {
            controllerId: 'instance01'
          }
        }
      }
    }())

    daemon._instanceId = 'instance02'
    daemon._externalSecretEvents = fakeExternalSecretEvents
    daemon._addPoller = sinon.mock()
    daemon._removePoller = sinon.mock()

    await daemon.start()
    daemon.stop()

    expect(daemon._addPoller.called).to.equal(false)
  })

  describe('secret name index', () => {
    const secretsManagerEvent = (type, uid, keys) => ({
      type,
      object: {
        metadata: {
          name: 'foo',
          namespace: 'foo',
          uid
        },
        spec: {
          backendType: 'secretsManager',
          data: keys.map(key => ({ key, name: 'value' }))
        }
      }
    })

    const runEvents = async (...events) => {
      daemon._externalSecretEvents = (async function * () {
        for (const event of events) yield event
      }())
      await daemon.start()
    }

    it('indexes added secretsManager pollers under raw and stripped candidates', async () => {
      await runEvents(secretsManagerEvent('ADDED', 'uid-1', ['app/db-Ab1234']))

      expect(daemon.getPollersForSecretName('app/db-Ab1234')).to.deep.equal([pollerMock])
      expect(daemon.getPollersForSecretName('app/db')).to.deep.equal([pollerMock])
    })

    it('cleans up the index on DELETED', async () => {
      await runEvents(
        secretsManagerEvent('ADDED', 'uid-1', ['app/db']),
        secretsManagerEvent('DELETED', 'uid-1', ['app/db'])
      )

      expect(daemon.getPollersForSecretName('app/db')).to.deep.equal([])
      expect(daemon._secretNameIndex.size).to.equal(0)
      expect(daemon._pollerSecretNames.size).to.equal(0)
    })

    it('re-indexes on MODIFIED', async () => {
      await runEvents(
        secretsManagerEvent('ADDED', 'uid-1', ['app/old']),
        secretsManagerEvent('MODIFIED', 'uid-1', ['app/new'])
      )

      expect(daemon.getPollersForSecretName('app/old')).to.deep.equal([])
      expect(daemon.getPollersForSecretName('app/new')).to.deep.equal([pollerMock])
    })

    it('does not index non-secretsManager backends', async () => {
      await runEvents({
        type: 'ADDED',
        object: {
          metadata: { name: 'foo', namespace: 'foo', uid: 'uid-1' },
          spec: {
            backendType: 'systemManager',
            data: [{ key: 'app/db', name: 'value' }]
          }
        }
      })

      expect(daemon.getPollersForSecretName('app/db')).to.deep.equal([])
    })

    it('returns an empty list for unknown names', () => {
      expect(daemon.getPollersForSecretName('nope')).to.deep.equal([])
    })
  })
})
