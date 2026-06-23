'use strict'

const { KubeConfig, CoreV1Api, CustomObjectsApi, Watch } = require('@kubernetes/client-node')
const pino = require('pino')
const yaml = require('js-yaml')
const fs = require('fs')
const path = require('path')

const awsConfig = require('./aws-config')
const envConfig = require('./environment')
const SecretsManagerBackend = require('../lib/backends/secrets-manager-backend')
const SystemManagerBackend = require('../lib/backends/system-manager-backend')

// Get document, or throw exception on error

const customResourceManifest = yaml.load(fs.readFileSync(path.resolve(__dirname, '../charts/kubernetes-external-secrets/crds/kubernetes-client.io_externalsecrets_crd.yaml'), 'utf8'))

const kubeconfig = new KubeConfig()
kubeconfig.loadFromDefault()
const kubeClient = {
  core: kubeconfig.makeApiClient(CoreV1Api),
  customObjects: kubeconfig.makeApiClient(CustomObjectsApi),
  watch: new Watch(kubeconfig)
}

const logger = pino({
  serializers: {
    err: pino.stdSerializers.err
  },
  redact: ['err.options.headers', 'err.options.json.jwt'],
  messageKey: envConfig.logMessageKey || 'msg',
  level: envConfig.logLevel,
  base: envConfig.logBase,
  formatters: {
    level (label, number) {
      return { level: envConfig.useHumanReadableLogLevels ? label : number }
    }
  },
  nestedKey: 'payload',
  timestamp: () => `,"message_time":"${new Date(Date.now()).toISOString()}"`
})

const secretsManagerBackend = new SecretsManagerBackend({
  clientFactory: awsConfig.secretsManagerFactory,
  assumeRole: awsConfig.assumeRole,
  logger
})
const systemManagerBackend = new SystemManagerBackend({
  clientFactory: awsConfig.systemManagerFactory,
  assumeRole: awsConfig.assumeRole,
  logger
})

const backends = {
  // when adding a new backend, make sure to change the CRD property too
  secretsManager: secretsManagerBackend,
  systemManager: systemManagerBackend
}

// backwards compatibility
backends.secretManager = secretsManagerBackend

module.exports = {
  awsConfig,
  backends,
  customResourceManifest,
  ...envConfig,
  kubeClient,
  logger
}
