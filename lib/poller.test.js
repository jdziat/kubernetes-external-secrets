'use strict'

const { expect } = require('chai')
const sinon = require('sinon')

const Poller = require('./poller')

describe('Poller', () => {
  let backendMock
  let kubeClientMock
  let loggerMock
  let metricsMock
  let pollerFactory
  let fakeCustomResourceManifest
  let fakeExternalSecret

  const getOwnerReference = () => ({
    apiVersion: fakeExternalSecret.apiVersion,
    controller: true,
    kind: fakeExternalSecret.kind,
    name: fakeExternalSecret.metadata.name,
    uid: fakeExternalSecret.metadata.uid
  })

  const rolePermittedAnnotation = 'iam.amazonaws.com/permitted'
  const namingPermittedAnnotation = 'externalsecrets.kubernetes-client.io/permitted-key-name'

  beforeEach(() => {
    backendMock = sinon.mock()
    kubeClientMock = {
      core: {
        readNamespace: sinon.stub(),
        readNamespacedSecret: sinon.stub(),
        createNamespacedSecret: sinon.stub(),
        replaceNamespacedSecret: sinon.stub()
      },
      customObjects: {
        getNamespacedCustomObjectStatus: sinon.stub(),
        replaceNamespacedCustomObjectStatus: sinon.stub()
      },
      watch: {
        watch: sinon.stub()
      }
    }
    loggerMock = sinon.mock()
    metricsMock = sinon.mock()

    loggerMock.info = sinon.stub()
    loggerMock.debug = sinon.stub()
    loggerMock.error = sinon.stub()

    metricsMock.observeSync = sinon.stub()

    fakeCustomResourceManifest = {
      spec: {
        group: 'kubernetes-client.io',
        names: {
          plural: 'externalsecrets'
        }
      }
    }

    fakeExternalSecret = {
      apiVersion: 'kubernetes-client.io/v1',
      kind: 'ExternalSecret',
      metadata: {
        namespace: 'fakeNamespace',
        name: 'fakeSecretName',
        uid: '4c10d879-2646-40dc-8595-d0b06b60a9ed',
        generation: 1
      }
    }

    pollerFactory = (spec = {
      backendType: 'fakeBackendType',
      properties: [
        'fakePropertyName1',
        'fakePropertyName2'
      ]
    }) => {
      fakeExternalSecret.spec = spec
      return new Poller({
        backends: {
          fakeBackendType: backendMock
        },
        metrics: metricsMock,
        intervalMilliseconds: 5000,
        kubeClient: kubeClientMock,
        logger: loggerMock,
        externalSecret: fakeExternalSecret,
        rolePermittedAnnotation,
        namingPermittedAnnotation,
        customResourceManifest: fakeCustomResourceManifest
      })
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('backwards compat with secretDescriptor', () => {
    const mySpec = {
      dataFrom: ['some-key', 'some-other'],
      backendType: 'my-magical-backend'
    }

    fakeExternalSecret.secretDescriptor = mySpec

    const myPoller = new Poller({
      backends: {
        fakeBackendType: backendMock
      },
      metrics: metricsMock,
      intervalMilliseconds: 5000,
      kubeClient: kubeClientMock,
      logger: loggerMock,
      externalSecret: fakeExternalSecret,
      rolePermittedAnnotation,
      customResourceManifest: fakeCustomResourceManifest
    })

    expect(myPoller._spec).to.deep.equal(mySpec)
  })

  describe('_createSecretManifest', () => {
    let clock

    beforeEach(() => {
      clock = sinon.useFakeTimers({
        now: Date.now()
      })
      backendMock.getSecretManifestData = sinon.stub()
    })

    afterEach(() => {
      clock.restore()
    })

    it('creates secret manifest - no type (backwards compat)', async () => {
      const poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: [
          'fakePropertyName1',
          'fakePropertyName2'
        ]
      })

      backendMock.getSecretManifestData.resolves({
        fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
        fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(backendMock.getSecretManifestData.calledWith(sinon.match({
        spec: {
          backendType: 'fakeBackendType',
          name: 'fakeSecretName',
          properties: [
            'fakePropertyName1',
            'fakePropertyName2'
          ]
        }
      }))).to.equal(true)

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName',
          ownerReferences: [getOwnerReference()]
        },
        type: 'Opaque',
        data: {
          fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
          fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
        }
      })
    })

    it('creates secret manifest - with type (backwards compat)', async () => {
      const poller = pollerFactory({
        type: 'dummy-test-type',
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        data: [
          'fakePropertyName1',
          'fakePropertyName2'
        ]
      })

      backendMock.getSecretManifestData.resolves({
        fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
        fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(backendMock.getSecretManifestData.calledWith(sinon.match({
        spec: {
          type: 'dummy-test-type',
          backendType: 'fakeBackendType',
          name: 'fakeSecretName',
          data: [
            'fakePropertyName1',
            'fakePropertyName2'
          ]
        }
      }))).to.equal(true)

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName',
          ownerReferences: [getOwnerReference()]
        },
        type: 'dummy-test-type',
        data: {
          fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
          fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
        }
      })
    })

    it('creates secret manifest - with template type (should work with backwards compat type)', async () => {
      const poller = pollerFactory({
        template: {
          type: 'dummy-test-type'
        },
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        data: []
      })

      backendMock.getSecretManifestData.resolves({})

      const secretManifest = await poller._createSecretManifest()

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName',
          ownerReferences: [getOwnerReference()]
        },
        type: 'dummy-test-type',
        data: {}
      })
    })

    it('creates secret manifest - with template', async () => {
      const poller = pollerFactory({
        type: 'dummy-test-type',
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: [
          'fakePropertyName1',
          'fakePropertyName2'
        ],
        template: {
          metadata: {
            annotations: {
              cat: 'cheese'
            },
            labels: {
              dog: 'farfel'
            },
            name: 'fakerSecretName'
          }
        }
      })

      backendMock.getSecretManifestData.resolves({
        fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
        fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(backendMock.getSecretManifestData.calledWith(sinon.match({
        spec: {
          type: 'dummy-test-type',
          backendType: 'fakeBackendType',
          name: 'fakeSecretName',
          properties: [
            'fakePropertyName1',
            'fakePropertyName2'
          ],
          template: {
            metadata: {
              annotations: {
                cat: 'cheese'
              },
              labels: {
                dog: 'farfel'
              },
              name: 'fakerSecretName'
            }
          }
        }
      }))).to.equal(true)

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName',
          ownerReferences: [getOwnerReference()],
          annotations: {
            cat: 'cheese'
          },
          labels: {
            dog: 'farfel'
          }
        },
        type: 'dummy-test-type',
        data: {
          fakePropertyName1: 'ZmFrZVByb3BlcnR5VmFsdWUx', // base 64 value
          fakePropertyName2: 'ZmFrZVByb3BlcnR5VmFsdWUy' // base 64 value
        }
      })
    })

    it('creates secret manifest - with lodash template', async () => {
      const poller = pollerFactory({
        type: 'dummy-test-type',
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        template: {
          metadata: {
            labels: {
              world: '<% let content = JSON.parse(data.s1) %><%= content.f2.f22 %>'
            }
          },
          stringData: {
            'test.yaml': `
              <%= yaml.dump(JSON.parse(data.s1)) %>
              <% let s2 = JSON.parse(data.s2) %><% s2.arr.forEach((e, i) => { %>arr_<%= i %>: <%= e %>
              <% }) %>
            `
          }
        },
        data: [
          { key: 'kv/data/test/secret1', name: 's1' },
          { key: 'kv/data/test/secret2', name: 's2' }
        ]
      })

      backendMock.getSecretManifestData.resolves({
        s1: 'eyJmMSI6MTEsImYyIjp7ImYyMiI6ImhlbGxvIn19Cg==', // base 64 value
        s2: 'eyJhcnIiOlsxLDIsM119' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          ownerReferences: [getOwnerReference()],
          labels: {
            world: 'hello'
          },
          name: 'fakeSecretName'
        },
        type: 'dummy-test-type',
        data: {
          s1: 'eyJmMSI6MTEsImYyIjp7ImYyMiI6ImhlbGxvIn19Cg==', // base 64 value
          s2: 'eyJhcnIiOlsxLDIsM119' // base 64 value
        },
        stringData: {
          'test.yaml': '\n              f1: 11\nf2:\n  f22: hello\n\n              arr_0: 1\n              arr_1: 2\n              arr_2: 3\n              \n            '
        }
      })
    })

    it('creates secret manifest - with lodash template (without stringData)', async () => {
      const poller = pollerFactory({
        type: 'dummy-test-type',
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        template: {
          metadata: {
            labels: {
              world: '<% let content = JSON.parse(data.s1) %><%= content.f2.f22 %>'
            }
          }
        },
        data: [
          { key: 'kv/data/test/secret1', name: 's1' }
        ]
      })

      backendMock.getSecretManifestData.resolves({
        s1: 'eyJmMSI6MTEsImYyIjp7ImYyMiI6ImhlbGxvIn19Cg==' // base 64 value
      })

      const secretManifest = await poller._createSecretManifest()

      expect(secretManifest).deep.equals({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          ownerReferences: [getOwnerReference()],
          labels: {
            world: 'hello'
          },
          name: 'fakeSecretName'
        },
        type: 'dummy-test-type',
        data: {
          s1: 'eyJmMSI6MTEsImYyIjp7ImYyMiI6ImhlbGxvIn19Cg==' // base 64 value
        }
      })
    })
  })

  describe('_poll', () => {
    let poller
    beforeEach(() => {
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        properties: ['fakePropertyName1', 'fakePropertyName2']
      })
      poller._upsertKubernetesSecret = sinon.stub()
      poller._setNextPoll = sinon.stub()
      poller._updateStatus = sinon.stub()
    })

    it('polls secrets', async () => {
      poller._upsertKubernetesSecret.resolves()

      await poller._poll()
      expect(loggerMock.info.calledWith(`running poll on the secret ${poller._namespace}/${poller._name}`)).to.equal(true)

      expect(metricsMock.observeSync.getCall(0).args[0]).to.deep.equal({
        name: 'fakeSecretName',
        namespace: 'fakeNamespace',
        backend: 'fakeBackendType',
        status: 'success'
      })
      expect(poller._updateStatus.calledWith('SUCCESS')).to.equal(true)
      expect(poller._upsertKubernetesSecret.calledWith()).to.equal(true)
    })

    it('logs error if storing secret operation fails', async () => {
      const error = new Error('fake error message')
      poller._upsertKubernetesSecret.throws(error)

      await poller._poll()

      expect(metricsMock.observeSync.getCall(0).args[0]).to.deep.equal({
        name: 'fakeSecretName',
        namespace: 'fakeNamespace',
        backend: 'fakeBackendType',
        status: 'error'
      })
      expect(poller._updateStatus.calledWith(`ERROR, ${error.message}`)).to.equal(true)
      expect(loggerMock.error.calledWith(error, `failure while polling the secret ${poller._namespace}/${poller._name}`)).to.equal(true)
    })

    it('never rejects, even when the error-status update itself fails', async () => {
      // _poll runs from a timer; a rejection here is an unhandled rejection
      // that kills the process under make-promises-safe.
      poller._upsertKubernetesSecret.throws(new Error('upsert boom'))
      const statusError = new Error('status boom')
      statusError.code = 500
      poller._updateStatus.rejects(statusError)

      await poller._poll()

      expect(loggerMock.error.calledWith(statusError, `failure while updating error status for ${poller._namespace}/${poller._name}`)).to.equal(true)
    })
  })

  describe('_updateStatus', () => {
    it('includes observedVersions on SUCCESS when the backend reported them', async () => {
      kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.resolves({})
      const poller = pollerFactory()
      poller._observedVersions = new Map([['demo/credentials', 'version-abc-123']])

      await poller._updateStatus('SUCCESS')

      const body = kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.getCall(0).args[0].body
      expect(body.status.observedVersions).to.deep.equal({ 'demo/credentials': 'version-abc-123' })
    })

    it('omits observedVersions on error status and when nothing was observed', async () => {
      kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.resolves({})
      const poller = pollerFactory()

      poller._observedVersions = new Map([['demo/credentials', 'version-abc-123']])
      await poller._updateStatus('ERROR, something broke')
      let body = kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.getCall(0).args[0].body
      expect(body.status.observedVersions).to.equal(undefined)

      poller._observedVersions = new Map()
      await poller._updateStatus('SUCCESS')
      body = kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.getCall(1).args[0].body
      expect(body.status.observedVersions).to.equal(undefined)
    })

    it('handles 404 - externalsecret deleted mid-poll', async () => {
      const notFoundError = new Error('NotFound')
      notFoundError.code = 404
      kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.throws(notFoundError)

      const poller = pollerFactory()

      await poller._updateStatus('SUCCESS')

      expect(loggerMock.info.calledWith(`externalsecret ${poller._namespace}/${poller._name} is gone, skipping status update`)).to.equal(true)
    })

    it('handles 409 - Conflict', async () => {
      const conflictError = new Error('Conflict')
      conflictError.code = 409
      kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.throws(conflictError)

      const poller = pollerFactory()

      await poller._updateStatus('SUCCESS')

      expect(loggerMock.info.calledWith(`status update failed for externalsecret ${poller._namespace}/${poller._name}, due to modification, new poller should start`)).to.equal(true)
    })

    it('rethrows other errors', async () => {
      const serverError = new Error('Internal Server Error')
      serverError.code = 500
      kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.throws(serverError)

      const poller = pollerFactory()
      let error

      try {
        await poller._updateStatus('SUCCESS')
      } catch (err) {
        error = err
      }

      expect(error).to.not.equal(undefined)
      expect(error.message).equals('Internal Server Error')
    })

    it('handles odd whitespace and newlines in status', async () => {
      const poller = pollerFactory()

      await poller._updateStatus('\n\n\nLots      of spaces\n\n\n').then(() => {
        const statusMessage = kubeClientMock.customObjects.replaceNamespacedCustomObjectStatus.getCall(0).args[0].body.status.status
        expect(statusMessage).to.equal('Lots of spaces')
      })
    })
  })

  describe('_scheduleNextPoll', () => {
    let poller
    let clock
    let fakeStatus
    let fakeDate

    beforeEach(() => {
      clock = sinon.useFakeTimers({
        now: Date.now()
      })

      poller = pollerFactory({
        backendType: 'fakeBackendType',
        properties: ['fakePropertyName']
      })

      poller._setNextPoll = sinon.stub()
      poller._poll = sinon.stub()

      fakeDate = new Date()

      fakeStatus = {
        status: {
          lastSync: fakeDate.toISOString(),
          observedGeneration: fakeExternalSecret.metadata.generation
        }
      }

      kubeClientMock.customObjects.getNamespacedCustomObjectStatus.resolves(fakeStatus)
    })

    afterEach(() => {
      clock.restore()
    })

    describe('last sync', () => {
      it('no last sync', async () => {
        delete fakeStatus.status.lastSync

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith({
          group: fakeCustomResourceManifest.spec.group,
          version: 'v1',
          namespace: fakeExternalSecret.metadata.namespace,
          plural: fakeCustomResourceManifest.spec.names.plural,
          name: fakeExternalSecret.metadata.name
        })).to.equal(true)
        expect(poller._setNextPoll.calledWith(0)).to.equal(true)
      })

      it('with new last sync - queues poll', async () => {
        const elapsedTime = 2000
        clock.tick(elapsedTime)

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
        expect(poller._setNextPoll.calledWith(poller._intervalMilliseconds - elapsedTime)).to.equal(true)
      })

      it('with last sync in the future - triggers poll', async () => {
        fakeDate.setFullYear(fakeDate.getFullYear() + 1)
        fakeStatus.status.lastSync = fakeDate.toISOString()

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
        expect(poller._setNextPoll.calledWith(0)).to.equal(true)
      })

      it('with old last sync - triggers poll', async () => {
        clock.tick(poller._intervalMilliseconds * 2) // greater than poller._intervalMilliseconds

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
        expect(poller._setNextPoll.calledWith(0)).to.equal(true)
      })
    })

    describe('generation', () => {
      it('no observed generation', async () => {
        delete fakeStatus.status.observedGeneration

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
        expect(poller._setNextPoll.calledWith(0)).to.equal(true)
      })

      it('with newer observed generation - queues poll', async () => {
        fakeExternalSecret.metadata.generation = 10
        fakeStatus.status.observedGeneration = 100

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
        expect(poller._setNextPoll.calledWith(fakeDate.getTime() - (Date.now() - poller._intervalMilliseconds))).to.equal(true)
      })

      it('with older observed generation - triggers poll', async () => {
        fakeExternalSecret.metadata.generation = 10
        fakeStatus.status.observedGeneration = 1

        await poller._scheduleNextPoll()

        expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
        expect(poller._setNextPoll.calledWith(0)).to.equal(true)
      })
    })

    it('disable interval polling', async () => {
      poller = new Poller({
        intervalMilliseconds: 5000,
        kubeClient: kubeClientMock,
        logger: loggerMock,
        externalSecret: fakeExternalSecret,
        customResourceManifest: fakeCustomResourceManifest,
        // Disable polling!
        pollingDisabled: true
      })

      poller._setNextPoll = sinon.stub()

      await poller._scheduleNextPoll()

      expect(kubeClientMock.customObjects.getNamespacedCustomObjectStatus.calledWith()).to.equal(true)
      sinon.assert.notCalled(poller._setNextPoll)
    })

    it('logs error if it fails', async () => {
      const error = new Error('something boom')
      kubeClientMock.customObjects.getNamespacedCustomObjectStatus.throws(error)

      await poller._scheduleNextPoll()
      expect(loggerMock.error.calledWith(error, 'status check went boom for fakeNamespace/fakeSecretName')).to.equal(true)
    })
  })

  describe('_upsertKubernetesSecret', () => {
    let poller
    let fakeNamespace

    beforeEach(() => {
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        properties: ['fakePropertyName']
      })
      fakeNamespace = {
        metadata: {
          annotations: {}
        }
      }
      kubeClientMock.core.readNamespace.resolves(fakeNamespace)
      poller._createSecretManifest = sinon.stub().returns({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'fakeSecretName'
        },
        type: 'some-type',
        data: {
          fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
        }
      })
    })

    it('creates new secret', async () => {
      const notFoundError = new Error('Not Found')
      notFoundError.code = 404
      kubeClientMock.core.readNamespacedSecret.throws(notFoundError)
      kubeClientMock.core.createNamespacedSecret.resolves()

      await poller._upsertKubernetesSecret()

      expect(kubeClientMock.core.createNamespacedSecret.calledWith({
        namespace: 'fakeNamespace',
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'fakeSecretName'
          },
          type: 'some-type',
          data: {
            fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
          }
        }
      })).to.equal(true)
    })

    it("doesn't update a secret if it hasn't changed", async () => {
      kubeClientMock.core.readNamespacedSecret.resolves({
        metadata: {
          name: 'fakeSecretName'
        },
        data: {
          fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
        }
      })

      const result = await poller._upsertKubernetesSecret()
      expect(result).to.equal(true)
      expect(kubeClientMock.core.replaceNamespacedSecret.called).to.equal(false)
      expect(kubeClientMock.core.createNamespacedSecret.called).to.equal(false)
    })

    it('updates secret', async () => {
      kubeClientMock.core.readNamespacedSecret.resolves({
        metadata: {
          name: 'fakeSecretName'
        },
        data: {
          fakePropertyName: 'differentValue'
        }
      })
      kubeClientMock.core.replaceNamespacedSecret.resolves()
      kubeClientMock.core.readNamespace.resolves(fakeNamespace)

      await poller._upsertKubernetesSecret()

      expect(kubeClientMock.core.readNamespacedSecret.calledWith({ name: 'fakeSecretName', namespace: 'fakeNamespace' })).to.equal(true)
      expect(kubeClientMock.core.replaceNamespacedSecret.calledWith({
        name: 'fakeSecretName',
        namespace: 'fakeNamespace',
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'fakeSecretName'
          },
          type: 'some-type',
          data: {
            fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
          }
        }
      })).to.equal(true)
    })

    it('updates secret if the custom metadata has changed', async () => {
      kubeClientMock.core.readNamespacedSecret.resolves({
        metadata: {
          creationTimestamp: new Date().toDateString(),
          name: 'fakeSecretName',
          labels: {
            myFakeLabel: 'test'
          }
        },
        data: {
          fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
        }
      })
      kubeClientMock.core.replaceNamespacedSecret.resolves()
      kubeClientMock.core.readNamespace.resolves(fakeNamespace)

      await poller._upsertKubernetesSecret()

      expect(kubeClientMock.core.readNamespacedSecret.calledWith({ name: 'fakeSecretName', namespace: 'fakeNamespace' })).to.equal(true)
      expect(kubeClientMock.core.replaceNamespacedSecret.calledWith({
        name: 'fakeSecretName',
        namespace: 'fakeNamespace',
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'fakeSecretName'
          },
          type: 'some-type',
          data: {
            fakePropertyName: 'ZmFrZVByb3BlcnR5VmFsdWU='
          }
        }
      })).to.equal(true)
    })

    it('does not permit update of secret', async () => {
      fakeNamespace.metadata.annotations[rolePermittedAnnotation] = '^$'
      poller = pollerFactory({
        backendType: 'fakeBackendType',
        name: 'fakeSecretName',
        roleArn: 'arn:aws:iam::123456789012:role/test-role',
        properties: ['fakePropertyName']
      })
      kubeClientMock.core.readNamespace.resolves(fakeNamespace)

      let error
      try {
        await poller._upsertKubernetesSecret()
      } catch (err) {
        error = err
      }

      expect(error).to.not.equal(undefined)
      expect(error.message).equals('not allowed to fetch secret: fakeNamespace/fakeSecretName: namespace does not allow to assume role arn:aws:iam::123456789012:role/test-role')
    })

    it('fails storing secret', async () => {
      const internalErrorServer = new Error('Internal Error Server')
      internalErrorServer.code = 500
      const notFoundError = new Error('Not Found')
      notFoundError.code = 404
      kubeClientMock.core.readNamespacedSecret.throws(notFoundError)
      kubeClientMock.core.createNamespacedSecret.throws(internalErrorServer)

      let error

      try {
        await poller._upsertKubernetesSecret()
      } catch (err) {
        error = err
      }

      expect(error).to.not.equal(undefined)
      expect(error.message).equals('Internal Error Server')
    })
  })

  describe('start', () => {
    let poller

    beforeEach(() => {
      poller = pollerFactory()
      poller._scheduleNextPoll = sinon.stub()
    })

    afterEach(() => {
      poller.stop()
    })

    it('starts poller', async () => {
      expect(poller._timeoutId).to.equal(null)

      poller.start()

      expect(loggerMock.info.calledWith(`starting poller for ${poller._namespace}/${poller._name}`)).to.equal(true)
      expect(poller._scheduleNextPoll.called).to.equal(true)
    })
  })

  describe('stop', () => {
    let poller

    beforeEach(() => {
      poller = pollerFactory()
      poller._poll = sinon.stub()
    })

    it('stops poller', async () => {
      poller._timeoutId = 'some id'

      expect(poller._timeoutId).to.not.equal(null)

      poller.stop()

      expect(loggerMock.info.calledWith(`stopping poller for ${poller._namespace}/${poller._name}`)).to.equal(true)
      expect(poller._timeoutId).to.equal(null)
    })
  })

  describe('triggerSync', () => {
    let clock
    let poller

    beforeEach(() => {
      clock = sinon.useFakeTimers()
      poller = pollerFactory()
      poller._poll = sinon.stub()
    })

    afterEach(() => {
      poller.stop()
      clock.restore()
    })

    it('schedules a poll within the debounce window', () => {
      poller.triggerSync()
      clock.tick(Poller.EVENT_SYNC_DEBOUNCE_MILLISECONDS)

      expect(poller._poll.calledOnce).to.equal(true)
    })

    it('works when polling is disabled and start never armed a timer', () => {
      poller._pollingDisabled = true

      expect(poller._timeoutId).to.equal(null)

      poller.triggerSync()
      clock.tick(Poller.EVENT_SYNC_DEBOUNCE_MILLISECONDS)

      expect(poller._poll.calledOnce).to.equal(true)
    })

    it('coalesces calls arriving on different event-loop turns into a single poll', async () => {
      // Simulate an SQS batch: triggerSync calls separated by awaits,
      // like the consumer's per-message deleteMessage awaits.
      poller.triggerSync()
      await clock.tickAsync(1)
      poller.triggerSync()
      await clock.tickAsync(1)
      poller.triggerSync()
      await clock.tickAsync(Poller.EVENT_SYNC_DEBOUNCE_MILLISECONDS)

      expect(poller._poll.calledOnce).to.equal(true)
    })

    it('is a no-op after stop', () => {
      poller.stop()
      poller.triggerSync()
      clock.tick(Poller.EVENT_SYNC_DEBOUNCE_MILLISECONDS)

      expect(poller._poll.called).to.equal(false)
    })

    it('is not clobbered by a later full-interval reschedule', () => {
      poller.triggerSync()
      // Simulates start()'s un-awaited _scheduleNextPoll resolving after the
      // event arrived and rescheduling the full interval.
      poller._setNextPoll(poller._intervalMilliseconds)
      clock.tick(Poller.EVENT_SYNC_DEBOUNCE_MILLISECONDS)

      expect(poller._poll.calledOnce).to.equal(true)
    })

    it('survives triggerSync racing an in-flight _scheduleNextPoll status read', async () => {
      kubeClientMock.customObjects.getNamespacedCustomObjectStatus.callsFake(() =>
        new Promise((resolve) => setTimeout(() => resolve({
          status: { lastSync: new Date(Date.now()).toISOString(), observedGeneration: 1 }
        }), 30))
      )

      poller.start()
      await clock.tickAsync(5)
      poller.triggerSync()
      // let the status read resolve, then the debounce window elapse
      await clock.tickAsync(Poller.EVENT_SYNC_DEBOUNCE_MILLISECONDS + 30)

      expect(poller._poll.calledOnce).to.equal(true)
    })

    it('exposes name and namespace getters', () => {
      expect(poller.name).to.equal('fakeSecretName')
      expect(poller.namespace).to.equal('fakeNamespace')
    })
  })
  describe('assume-role permissions', () => {
    let poller
    beforeEach(() => {
      poller = pollerFactory()
    })

    it('should restrict access to certain roles per namespace ', () => {
      const testcases = [
        {
          // no annotations at all
          ns: { metadata: {} },
          descriptor: {},
          permitted: true
        },
        {
          // empty annotation
          ns: { metadata: { annotations: { [rolePermittedAnnotation]: '' } } },
          descriptor: {},
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [rolePermittedAnnotation]: '.*' } } },
          descriptor: { roleArn: 'whatever' },
          permitted: true
        },
        {
          // test regex: deny access
          ns: { metadata: { annotations: { [rolePermittedAnnotation]: '^$' } } },
          descriptor: { roleArn: 'whatever' },
          permitted: false
        },
        {
          // real world example
          ns: { metadata: { annotations: { [rolePermittedAnnotation]: 'arn:aws:iam::123456789012:role/.*' } } },
          descriptor: { roleArn: 'arn:aws:iam::123456789012:role/somerole' },
          permitted: true
        },
        {
          // test undefined
          ns: { metadata: { annotations: { [rolePermittedAnnotation]: 'my-kiam-role.*' } } },
          descriptor: {},
          permitted: true
        }
      ]

      for (let i = 0; i < testcases.length; i++) {
        const testcase = testcases[i]
        const verdict = poller._isPermitted(testcase.ns, testcase.descriptor)
        expect(verdict.allowed).to.equal(testcase.permitted)
      }
    })
  })
  describe('naming conventions', () => {
    let poller
    beforeEach(() => {
      poller = pollerFactory()
    })
    it('should restrict access as defined in namespace naming convention ', () => {
      const testcases = [
        {
          // no annotations at all
          ns: { metadata: {} },
          descriptor: {},
          permitted: true
        },
        {
          // empty annotation
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '' } } },
          descriptor: {},
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '.*' } } },
          descriptor: {
            data: [
              { key: 'whatever', name: 'somethingelse' }
            ]
          },
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'dev/team-a/secret', name: 'somethingelse' }
            ]
          },
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'dev/team-b/secret', name: 'somethingelse' }
            ]
          },
          permitted: false
        },
        {
          // test regex on path
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { path: 'dev/team-a/secret' }
            ]
          },
          permitted: true
        },
        {
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'dev/team-a/secret', name: 'somethingelse', path: '' }
            ]
          },
          permitted: false
        },
        {
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'this-should-fail', name: 'somethingelse', path: 'dev/team-a/such-path' }
            ]
          },
          permitted: false
        },
        {
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'dev/team-a/such-key', name: 'somethingelse', path: 'this-should-fail' }
            ]
          },
          permitted: false
        },
        {
          // test regex on path
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { path: 'dev/team-b/secret' }
            ]
          },
          permitted: false
        },
        {
          // test regex on path when key is also specified
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { path: 'dev/team-b/secret', key: 'dev/team-a/secret' }
            ]
          },
          permitted: false
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            dataFrom: [
              'dev/team-b/secret'
            ]
          },
          permitted: false
        },
        {
          // empty annotation
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '' } } },
          descriptor: {
            dataFrom: ['test']
          },
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            dataFrom: [
              'dev/team-a/secret'
            ]
          },
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '.*' } } },
          descriptor: {
            data: [
              { key: 'whatever', name: 'somethingelse' }
            ],
            dataFrom: ['something']
          },
          permitted: true
        },
        {
          // test regex data bad, dataFrom OK
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'dev/team-b/secret', name: 'somethingelse' }
            ],
            dataFrom: [
              'dev/team-a/ok-secret'
            ]
          },
          permitted: false
        },
        {
          // test regex data OK, dataFrom bad
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            data: [
              { key: 'dev/team-a/ok-secret', name: 'somethingelse' }
            ],
            dataFrom: [
              'dev/team-b/bad-secret'
            ]
          },
          permitted: false
        },
        {
          // dataFromWithOptions is subject to the naming convention too
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            dataFromWithOptions: [
              { key: 'dev/team-a/ok-secret' }
            ]
          },
          permitted: true
        },
        {
          // dataFromWithOptions must not bypass the naming convention
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'dev/team-a/.*' } } },
          descriptor: {
            dataFromWithOptions: [
              { key: 'dev/team-b/bad-secret' }
            ]
          },
          permitted: false
        },
        {
          // test multiple regex data
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: ['dev/team-a/.*', 'common/.*'] } } },
          descriptor: {
            data: [
              { key: 'dev/team-a/ok-secret', name: 'somethingelse' },
              { key: 'common/generic-secret', name: 'genericsecret' }
            ]
          },
          permitted: true
        },
        {
          // test multiple regex data
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: ['dev/team-a/.*', 'common/.*'] } } },
          descriptor: {
            data: [
              { key: 'dev/team-b/nok-secret', name: 'somethingelse' },
              { key: 'common/generic-secret', name: 'genericsecret' }
            ]
          },
          permitted: false
        },
        {
          // test multiple regex data
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: ['dev/team-b/.*', 'common/.*'] } } },
          descriptor: {
            data: [
              { key: 'common/generic-secret', name: 'genericsecret' }
            ],
            dataFrom: [
              'common/generic-secret'
            ]
          },
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '.*', [rolePermittedAnnotation]: 'a' } } },
          descriptor: {
            data: [
              { key: 'whatever', name: 'somethingelse' }
            ],
            roleArn: 'b'
          },
          permitted: false
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '.*', [rolePermittedAnnotation]: 'a' } } },
          descriptor: {
            data: [
              { key: 'whatever', name: 'somethingelse' }
            ],
            vaultRole: 'b'
          },
          permitted: false
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '.*', [rolePermittedAnnotation]: 'a' } } },
          descriptor: {
            data: [
              { key: 'whatever', name: 'somethingelse' }
            ],
            roleArn: 'a'
          },
          permitted: true
        },
        {
          // test regex
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '.*', [rolePermittedAnnotation]: 'a' } } },
          descriptor: {
            data: [
              { key: 'whatever', name: 'somethingelse' }
            ],
            vaultRole: 'a'
          },
          permitted: true
        }
      ]

      for (let i = 0; i < testcases.length; i++) {
        const testcase = testcases[i]
        const verdict = poller._isPermitted(testcase.ns, testcase.descriptor)
        expect(verdict.allowed, `test case ${i + 1}`).to.equal(testcase.permitted)
      }
    })
  })
  describe('namespace annotation enforcement', () => {
    let poller
    beforeEach(() => {
      poller = new Poller({
        backends: {
          fakeBackendType: backendMock
        },
        metrics: metricsMock,
        intervalMilliseconds: 5000,
        kubeClient: kubeClientMock,
        logger: loggerMock,
        externalSecret: fakeExternalSecret,
        rolePermittedAnnotation,
        namingPermittedAnnotation,
        enforceNamespaceAnnotation: true,
        customResourceManifest: fakeCustomResourceManifest
      })
    })

    it('should enforce namespace annotations`', () => {
      const testcases = [
        {
          // no annotations at all
          ns: { metadata: {} },
          descriptor: {},
          permitted: false
        },
        {
          // empty name annotation
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: '' } } },
          descriptor: {
            dataFrom: ['test']
          },
          permitted: false
        },
        {
          // empty role annotation
          ns: { metadata: { annotations: { [rolePermittedAnnotation]: '' } } },
          descriptor: {
            dataFrom: ['test']
          },
          permitted: false
        },
        {
          // missing role annotation
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'a' } } },
          descriptor: {
            dataFrom: ['a'],
            roleArn: 'a'
          },
          permitted: false
        },
        {
          // empty role annotation
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'a', [rolePermittedAnnotation]: '' } } },
          descriptor: {
            dataFrom: ['a'],
            roleArn: 'a'
          },
          permitted: false
        },
        {
          // all required annotations
          ns: { metadata: { annotations: { [namingPermittedAnnotation]: 'a', [rolePermittedAnnotation]: 'b' } } },
          descriptor: {
            dataFrom: ['a']
          },
          permitted: true
        }
      ]

      for (let i = 0; i < testcases.length; i++) {
        const testcase = testcases[i]
        const verdict = poller._isPermitted(testcase.ns, testcase.descriptor)
        expect(verdict.allowed, `test case ${i + 1}`).to.equal(testcase.permitted)
      }
    })
  })
})
