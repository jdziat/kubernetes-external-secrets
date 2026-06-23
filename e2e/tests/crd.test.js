/* eslint-env mocha */
'use strict'

const k8s = require('@kubernetes/client-node')
const { expect } = require('chai')

const {
  customResourceManifest
} = require('../../config')

const {
  uuid,
  createExternalSecret
} = require('./framework.js')

const kc = new k8s.KubeConfig()
kc.loadFromDefault()
const apiExtensions = kc.makeApiClient(k8s.ApiextensionsV1Api)

describe('CRD', () => {
  it('ensure CRD is managed correctly', async () => {
    const res = await apiExtensions.readCustomResourceDefinition({ name: customResourceManifest.metadata.name })

    const managedBy = 'helm'
    expect(res).to.not.equal(undefined)
    expect(res.metadata.annotations['app.kubernetes.io/managed-by']).to.equal(managedBy)
  })

  it('should reject invalid ExternalSecret manifests', async () => {
    return createExternalSecret('default', {
      apiVersion: 'kubernetes-client.io/v1',
      kind: 'ExternalSecret',
      metadata: {
        name: `e2e-test-validation-${uuid}`
      },
      secretDescriptor: {
        backendType: 'systemManager',
        data: [
          {
            key: `/e2e/${uuid}/name`,
            name: 'name'
          }
        ]
      }
    })
      .then(() => { throw new Error('was not supposed to succeed') })
      .catch((err) => {
        // A genuine apiserver rejection is an ApiException carrying an HTTP status
        // code. The sentinel Error thrown above has no numeric .code, so this fails
        // (rather than silently passing) if the invalid manifest was wrongly accepted.
        expect(err.code, `expected an HTTP rejection but got: ${err.message}`).to.be.a('number')
        expect(err.code).to.be.at.least(400)
      })
  })
})
