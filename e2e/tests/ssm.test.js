/* eslint-env mocha */
'use strict'

const { expect } = require('chai')

const {
  kubeClient,
  customResourceManifest,
  awsConfig
} = require('../../config')
const { waitForSecret, uuid, createExternalSecret } = require('./framework.js')
const { PatchStrategy, setHeaderOptions } = require('@kubernetes/client-node')

const ssm = awsConfig.systemManagerFactory()
const putParameter = (params) => ssm.putParameter(params)

describe('ssm', async () => {
  it('should pull existing secret from ssm and create a secret from it', async () => {
    let result = await putParameter({
      Name: `/e2e/${uuid}/name`,
      Type: 'String',
      Value: 'foo'
    }).catch(err => {
      expect(err).to.equal(null)
    })

    result = await createExternalSecret('default', {
      apiVersion: 'kubernetes-client.io/v1',
      kind: 'ExternalSecret',
      metadata: {
        name: `e2e-ssm-${uuid}`
      },
      spec: {
        backendType: 'systemManager',
        data: [
          {
            key: `/e2e/${uuid}/name`,
            name: 'name'
          }
        ]
      }
    })

    expect(result).to.not.equal(undefined)

    const secret = await waitForSecret('default', `e2e-ssm-${uuid}`)
    expect(secret.data.name).to.equal('Zm9v')
  })

  it('should pull existing secrets from ssm path and create a secret from it', async () => {
    const name1 = await putParameter({
      Name: `/e2e/${uuid}-names/name1`,
      Type: 'String',
      Value: 'foo'
    }).catch(err => {
      expect(err).to.equal(null)
    })

    const name2 = await putParameter({
      Name: `/e2e/${uuid}-names/name2`,
      Type: 'String',
      Value: 'bar'
    }).catch(err => {
      expect(err).to.equal(null)
    })

    const result = await createExternalSecret('default', {
      apiVersion: 'kubernetes-client.io/v1',
      kind: 'ExternalSecret',
      metadata: {
        name: `e2e-ssm-${uuid}-names`
      },
      spec: {
        backendType: 'systemManager',
        data: [
          {
            path: `/e2e/${uuid}-names`
          }
        ]
      }
    })

    expect(name1).to.not.equal(undefined)
    expect(name2).to.not.equal(undefined)
    expect(result).to.not.equal(undefined)

    const secret = await waitForSecret('default', `e2e-ssm-${uuid}-names`)
    expect(secret.data.name1).to.equal('Zm9v') // Expect base64 foo
    expect(secret.data.name2).to.equal('YmFy') // Expect base64 bar
  })

  it('should pull existing secret from ssm in a different region', async () => {
    const ssmEU = awsConfig.systemManagerFactory({
      region: 'eu-west-1'
    })
    const putParameter = (params) => ssmEU.putParameter(params)

    let result = await putParameter({
      Name: `/e2e/${uuid}/x-region`,
      Type: 'String',
      Value: 'foo'
    }).catch(err => {
      expect(err).to.equal(null)
    })

    result = await createExternalSecret('default', {
      apiVersion: 'kubernetes-client.io/v1',
      kind: 'ExternalSecret',
      metadata: {
        name: `e2e-ssm-xregion-${uuid}`
      },
      spec: {
        backendType: 'systemManager',
        region: 'eu-west-1',
        data: [
          {
            key: `/e2e/${uuid}/x-region`,
            name: 'name'
          }
        ]
      }
    })

    expect(result).to.not.equal(undefined)

    const secret = await waitForSecret('default', `e2e-ssm-xregion-${uuid}`)
    expect(secret.data.name).to.equal('Zm9v')
  })

  describe('permitted annotation', async () => {
    beforeEach(async () => {
      await kubeClient.core.patchNamespace({
        name: 'default',
        body: {
          metadata: {
            annotations: {
              'iam.amazonaws.com/permitted': '^(foo|bar)'
            }
          }
        }
      }, setHeaderOptions('Content-Type', PatchStrategy.MergePatch))
    })

    afterEach(async () => {
      await kubeClient.core.patchNamespace({
        name: 'default',
        body: {
          metadata: {
            annotations: {
              'iam.amazonaws.com/permitted': '.*'
            }
          }
        }
      }, setHeaderOptions('Content-Type', PatchStrategy.MergePatch))
    })

    it('should not pull from ssm', async () => {
      let result = await putParameter({
        Name: `/e2e/permitted/${uuid}`,
        Type: 'String',
        Value: 'foo'
      }).catch(err => {
        expect(err).to.equal(null)
      })

      result = await createExternalSecret('default', {
        apiVersion: 'kubernetes-client.io/v1',
        kind: 'ExternalSecret',
        metadata: {
          name: `e2e-ssm-permitted-${uuid}`
        },
        spec: {
          backendType: 'systemManager',
          roleArn: 'let-me-be-root',
          data: [
            {
              key: `/e2e/permitted/${uuid}`,
              name: 'name'
            }
          ]
        }
      })

      expect(result).to.not.equal(undefined)

      const secret = await waitForSecret('default', `e2e-ssm-permitted-${uuid}`)
      expect(secret).to.equal(undefined)

      result = await kubeClient.customObjects.getNamespacedCustomObject({
        group: customResourceManifest.spec.group,
        version: 'v1',
        namespace: 'default',
        plural: customResourceManifest.spec.names.plural,
        name: `e2e-ssm-permitted-${uuid}`
      })
      expect(result).to.not.equal(undefined)
      expect(result.status.status).to.contain('namespace does not allow to assume role let-me-be-root')
    })
  })
})
