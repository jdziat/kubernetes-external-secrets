#!/usr/bin/env node

'use strict'

// make-promises-safe installs an process.on('unhandledRejection') handler
// that prints the stacktrace and exits the process
// with an exit code of 1, just like any uncaught exception.
require('make-promises-safe')

const Prometheus = require('prom-client')
const Daemon = require('../lib/daemon')
const MetricsServer = require('../lib/metrics-server')
const Metrics = require('../lib/metrics')
const { getExternalSecretEvents } = require('../lib/external-secret')
const PollerFactory = require('../lib/poller-factory')
const SqsConsumer = require('../lib/sqs-consumer')
const { regionFromSqsQueueUrl } = require('../lib/utils')

const {
  awsConfig,
  awsSqsQueueUrl,
  awsSqsWaitTimeSeconds,
  eventSyncMinIntervalMilliseconds,
  backends,
  kubeClient,
  customResourceManifest,
  logger,
  metricsPort,
  pollerIntervalMilliseconds,
  pollingDisabled,
  rolePermittedAnnotation,
  namingPermittedAnnotation,
  enforceNamespaceAnnotation,
  watchTimeout,
  watchedNamespaces,
  instanceId
} = require('../config')

async function main () {
  try {
    logger.info('verifying CRD is installed')
    await kubeClient.customObjects.listClusterCustomObject({
      group: customResourceManifest.spec.group,
      version: 'v1',
      plural: customResourceManifest.spec.names.plural
    })
  } catch (err) {
    logger.error('CRD installation check failed, statusCode: %s', err.code)
    process.exit(1)
  }

  const externalSecretEvents = getExternalSecretEvents({
    kubeClient,
    watchedNamespaces,
    customResourceManifest,
    logger,
    watchTimeout
  })

  const registry = Prometheus.register
  Prometheus.collectDefaultMetrics({ register: registry })
  const metrics = new Metrics({ registry })

  const pollerFactory = new PollerFactory({
    backends,
    kubeClient,
    metrics,
    pollerIntervalMilliseconds,
    rolePermittedAnnotation,
    namingPermittedAnnotation,
    enforceNamespaceAnnotation,
    customResourceManifest,
    pollingDisabled,
    logger
  })

  const daemon = new Daemon({
    externalSecretEvents,
    logger,
    pollerFactory,
    instanceId
  })

  const metricsServer = new MetricsServer({
    port: metricsPort,
    registry,
    logger
  })

  let sqsConsumer = null
  if (awsSqsQueueUrl) {
    // Talk to the queue's own region even if AWS_REGION points elsewhere;
    // URLs without a derivable region (e.g. LocalStack) use the default.
    const queueRegion = regionFromSqsQueueUrl(awsSqsQueueUrl)
    sqsConsumer = new SqsConsumer({
      queueUrl: awsSqsQueueUrl,
      sqsClient: awsConfig.sqsFactory(queueRegion ? { region: queueRegion } : {}),
      daemon,
      logger,
      metrics,
      waitTimeSeconds: awsSqsWaitTimeSeconds,
      minSyncIntervalMilliseconds: eventSyncMinIntervalMilliseconds
    })
  }

  logger.info('starting app')
  daemon.start()
  if (sqsConsumer) sqsConsumer.start()
  await metricsServer.start()
  logger.info('successfully started app')

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('received %s, shutting down gracefully', signal)
    try {
      // Stop consuming events before pollers are torn down so triggerSync
      // never races removed pollers.
      if (sqsConsumer) await sqsConsumer.stop()
      daemon.stop()
      await metricsServer.stop()
      logger.info('shutdown complete')
      process.exit(0)
    } catch (err) {
      logger.error('error during shutdown: %s', err.message)
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
