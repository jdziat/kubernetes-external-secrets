'use strict'

const { expect } = require('chai')
const sinon = require('sinon')

const { getExternalSecretEvents } = require('./external-secret')

describe('getExternalSecretEvents', () => {
  let kubeClientMock
  let watchedNamespaces
  let fakeCustomResourceManifest
  let loggerMock
  let watchCallback
  let watchDone
  let aborter

  beforeEach(() => {
    fakeCustomResourceManifest = {
      spec: {
        group: 'kubernetes-client.io',
        names: {
          plural: 'externalsecrets'
        }
      }
    }

    aborter = {
      abort: sinon.stub()
    }

    kubeClientMock = {
      watch: {
        watch: sinon.stub().callsFake((path, queryParams, callback, done) => {
          watchCallback = callback
          watchDone = done
          return Promise.resolve(aborter)
        })
      }
    }

    watchedNamespaces = []

    loggerMock = sinon.mock()
    loggerMock.info = sinon.stub()
    loggerMock.warn = sinon.stub()
    loggerMock.error = sinon.stub()
    loggerMock.debug = sinon.stub()
  })

  afterEach(() => {
    sinon.restore()
  })

  it('gets a stream of external secret events', async () => {
    const fakeExternalSecretObject = {
      apiVersion: 'kubernetes-client.io/v1',
      kind: 'ExternalSecret',
      metadata: {
        name: 'my-secret',
        namespace: 'default'
      },
      spec: { backendType: 'secretsManager', data: [] }
    }

    const events = getExternalSecretEvents({
      kubeClient: kubeClientMock,
      watchedNamespaces,
      customResourceManifest: fakeCustomResourceManifest,
      logger: loggerMock,
      watchTimeout: 5000
    })

    const modifiedEventPromise = events.next()
    await Promise.resolve()

    expect(kubeClientMock.watch.watch.calledWith(
      '/apis/kubernetes-client.io/v1/externalsecrets',
      {}
    )).to.equal(true)

    watchCallback('MODIFIED', fakeExternalSecretObject)
    const modifiedEvent = await modifiedEventPromise
    expect(modifiedEvent.value.type).is.equal('MODIFIED')
    expect(modifiedEvent.value.object).is.deep.equal(fakeExternalSecretObject)

    const addedEventPromise = events.next()
    watchCallback('ADDED', fakeExternalSecretObject)
    const addedEvent = await addedEventPromise
    expect(addedEvent.value.type).is.equal('ADDED')
    expect(addedEvent.value.object).is.deep.equal(fakeExternalSecretObject)

    const deletedEventPromise = events.next()
    watchCallback('DELETED', fakeExternalSecretObject)
    const deletedEvent = await deletedEventPromise
    expect(deletedEvent.value.type).is.equal('DELETED')
    expect(deletedEvent.value.object).is.deep.equal(fakeExternalSecretObject)

    const deletedAllEventPromise = events.next()
    watchDone()
    const deletedAllEvent = await deletedAllEventPromise
    expect(deletedAllEvent.value.type).is.equal('DELETED_ALL')
    expect(deletedAllEvent.value.object).is.deep.equal(undefined)
    expect(aborter.abort.called).to.equal(true)
  })
})
