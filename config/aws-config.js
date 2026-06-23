'use strict'

const { SecretsManager } = require('@aws-sdk/client-secrets-manager')
const { SSM } = require('@aws-sdk/client-ssm')
const { fromTemporaryCredentials } = require('@aws-sdk/credential-providers')
const { NodeHttpHandler } = require('@smithy/node-http-handler')
const { ProxyAgent } = require('proxy-agent')
const clonedeep = require('lodash/cloneDeep')
const merge = require('lodash/merge')

// AWS SDK v3 has no global config; an outbound proxy is configured per-client via
// a custom requestHandler. ProxyAgent resolves HTTP(S)_PROXY/NO_PROXY from the env.
let requestHandler
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const agent = new ProxyAgent()
  requestHandler = new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent })
}

const localstack = process.env.LOCALSTACK || 0

const intermediateRole = process.env.AWS_INTERMEDIATE_ROLE_ARN || 0

const stsEndpoint = process.env.AWS_STS_ENDPOINT || 0
const ssmEndpoint = process.env.AWS_SSM_ENDPOINT || 0
const smEndpoint = process.env.AWS_SM_ENDPOINT || 0

let secretsManagerConfig = {}
let systemManagerConfig = {}
let stsConfig = {
  region: process.env.AWS_REGION || 'us-west-2'
}

if (smEndpoint) {
  secretsManagerConfig.endpoint = smEndpoint
}

if (ssmEndpoint) {
  systemManagerConfig.endpoint = ssmEndpoint
}

if (stsEndpoint) {
  stsConfig.endpoint = stsEndpoint
}

if (localstack) {
  secretsManagerConfig = {
    endpoint: process.env.LOCALSTACK_SM_URL || 'http://localhost:4566',
    region: process.env.AWS_REGION || 'us-west-2'
  }
  systemManagerConfig = {
    endpoint: process.env.LOCALSTACK_SSM_URL || 'http://localhost:4566',
    region: process.env.AWS_REGION || 'us-west-2'
  }
  stsConfig = {
    endpoint: process.env.LOCALSTACK_STS_URL || 'http://localhost:4566',
    region: process.env.AWS_REGION || 'us-west-2'
  }
}

// Optional intermediate role assumed (chained) before the final role.
const intermediateCredentials = intermediateRole
  ? fromTemporaryCredentials({
    params: {
      RoleArn: intermediateRole,
      RoleSessionName: 'k8s-external-secrets'
    },
    clientConfig: stsConfig
  })
  : undefined

function withRequestHandler (config) {
  return requestHandler ? { ...config, requestHandler } : config
}

module.exports = {
  secretsManagerFactory: (opts = {}) => {
    let config = opts
    if (localstack) {
      config = merge(clonedeep(opts), secretsManagerConfig)
    }
    return new SecretsManager(withRequestHandler(config))
  },
  systemManagerFactory: (opts = {}) => {
    let config = opts
    if (localstack) {
      config = merge(clonedeep(opts), systemManagerConfig)
    }
    return new SSM(withRequestHandler(config))
  },
  assumeRole: (assumeRoleOpts) => {
    return fromTemporaryCredentials({
      params: assumeRoleOpts,
      masterCredentials: intermediateCredentials,
      clientConfig: stsConfig
    })
  }
}
