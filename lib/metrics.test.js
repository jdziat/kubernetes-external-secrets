'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const Prometheus = require('prom-client')

const Metrics = require('./metrics')

describe('Metrics', () => {
  let registry
  let metrics

  beforeEach(async () => {
    registry = new Prometheus.Registry()
    metrics = new Metrics({ registry })
  })

  afterEach(async () => {
    sinon.restore()
  })

  it('should store metrics', async () => {
    metrics.observeSync({
      name: 'foo',
      namespace: 'example',
      backend: 'foo',
      status: 'success'
    })
    expect(await registry.metrics()).to.have.string('kubernetes_external_secrets_sync_calls_count{name="foo",namespace="example",backend="foo",status="success"} 1')
    // Deprecated metric.
    expect(await registry.metrics()).to.have.string('sync_calls{name="foo",namespace="example",backend="foo",status="success"} 1')
  })

  it('should store event-driven sync metrics', async () => {
    metrics.observeSqsMessageReceived()
    metrics.observeSqsReceiveError()
    metrics.observeEventTriggeredSync({ name: 'foo', namespace: 'example' })

    const output = await registry.metrics()
    expect(output).to.have.string('kubernetes_external_secrets_sqs_messages_received_total 1')
    expect(output).to.have.string('kubernetes_external_secrets_sqs_receive_errors_total 1')
    expect(output).to.have.string('kubernetes_external_secrets_event_triggered_syncs_total{name="foo",namespace="example"} 1')
  })

  it('should track the sqs consumer running gauge', async () => {
    metrics.setSqsConsumerRunning(1)
    expect(await registry.metrics()).to.have.string('kubernetes_external_secrets_sqs_consumer_running 1')
    metrics.setSqsConsumerRunning(0)
    expect(await registry.metrics()).to.have.string('kubernetes_external_secrets_sqs_consumer_running 0')
  })
})
