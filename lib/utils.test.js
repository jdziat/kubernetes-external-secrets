'use strict'

const { expect } = require('chai')

const {
  collectSpecSecretEntries,
  expandSecretKeyCandidates,
  collectSecretsManagerIndexNames,
  clampSqsWaitTimeSeconds,
  parseNonNegativeMilliseconds,
  regionFromSqsQueueUrl
} = require('./utils')

describe('utils', () => {
  describe('expandSecretKeyCandidates', () => {
    it('extracts the resource name and stripped form from a full ARN', () => {
      const candidates = expandSecretKeyCandidates('arn:aws:secretsmanager:us-west-2:123456789012:secret:demo-service/credentials-Ab12Cd')
      expect(candidates).to.deep.equal([
        'demo-service/credentials-Ab12Cd',
        'demo-service/credentials'
      ])
    })

    it('takes a plain name literally, even one ending in a suffix-like segment', () => {
      expect(expandSecretKeyCandidates('demo-service/credentials')).to.deep.equal(['demo-service/credentials'])
      // Common human suffixes (-master, -config, ...) must not cross-match.
      expect(expandSecretKeyCandidates('my-secret-Ab1234')).to.deep.equal(['my-secret-Ab1234'])
      expect(expandSecretKeyCandidates('app/creds-master')).to.deep.equal(['app/creds-master'])
    })

    it('handles an ARN whose resource has no strippable suffix', () => {
      expect(expandSecretKeyCandidates('arn:aws:secretsmanager:eu-west-1:123456789012:secret:short')).to.deep.equal(['short'])
    })

    it('never emits an empty candidate for a degenerate ARN resource', () => {
      expect(expandSecretKeyCandidates('arn:aws:secretsmanager:eu-west-1:123456789012:secret:-Ab1234')).to.deep.equal(['-Ab1234'])
    })

    it('returns nothing for non-string or empty input', () => {
      expect(expandSecretKeyCandidates('')).to.deep.equal([])
      expect(expandSecretKeyCandidates(null)).to.deep.equal([])
      expect(expandSecretKeyCandidates(undefined)).to.deep.equal([])
    })
  })

  describe('collectSpecSecretEntries', () => {
    it('collects data entries with key, path and versionId', () => {
      const entries = collectSpecSecretEntries({
        data: [
          { key: 'a', name: 'x' },
          { path: '/prefix', name: 'y' },
          { key: 'b', versionId: 'v1' }
        ]
      })
      expect(entries).to.deep.equal([
        { source: 'data', key: 'a', path: undefined, versionId: undefined },
        { source: 'data', key: undefined, path: '/prefix', versionId: undefined },
        { source: 'data', key: 'b', path: undefined, versionId: 'v1' }
      ])
    })

    it('collects dataFrom strings and dataFromWithOptions entries', () => {
      const entries = collectSpecSecretEntries({
        dataFrom: ['foo'],
        dataFromWithOptions: [{ key: 'bar', versionId: 'v2' }]
      })
      expect(entries).to.deep.equal([
        { source: 'dataFrom', key: 'foo' },
        { source: 'dataFromWithOptions', key: 'bar', versionId: 'v2' }
      ])
    })

    it('supports the legacy properties field', () => {
      const entries = collectSpecSecretEntries({
        properties: [{ key: 'legacy' }]
      })
      expect(entries).to.have.length(1)
      expect(entries[0].key).to.equal('legacy')
    })

    it('returns an empty list for an empty or invalid spec', () => {
      expect(collectSpecSecretEntries({})).to.deep.equal([])
      expect(collectSpecSecretEntries(null)).to.deep.equal([])
    })
  })

  describe('collectSecretsManagerIndexNames', () => {
    it('collects candidates from all key fields, excluding versionId-pinned entries', () => {
      const names = collectSecretsManagerIndexNames({
        backendType: 'secretsManager',
        data: [
          { key: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:app/db-Ab1234', name: 'x' },
          { key: 'pinned', versionId: 'v1' }
        ],
        dataFrom: ['app/api'],
        dataFromWithOptions: [
          { key: 'app/cache' },
          { key: 'pinned-too', versionId: 'v2' }
        ]
      })
      expect(names).to.have.members([
        'app/db-Ab1234',
        'app/db',
        'app/api',
        'app/cache'
      ])
    })

    it('returns nothing for non-Secrets-Manager backends', () => {
      expect(collectSecretsManagerIndexNames({
        backendType: 'systemManager',
        data: [{ key: 'a' }]
      })).to.deep.equal([])
    })

    it('supports the secretManager backend alias', () => {
      expect(collectSecretsManagerIndexNames({
        backendType: 'secretManager',
        dataFrom: ['a']
      })).to.deep.equal(['a'])
    })

    it('dedupes candidates referenced more than once', () => {
      expect(collectSecretsManagerIndexNames({
        backendType: 'secretsManager',
        data: [{ key: 'a' }],
        dataFrom: ['a']
      })).to.deep.equal(['a'])
    })

    it('ignores path-only entries', () => {
      expect(collectSecretsManagerIndexNames({
        backendType: 'secretsManager',
        data: [{ path: '/prefix' }]
      })).to.deep.equal([])
    })
  })

  describe('clampSqsWaitTimeSeconds', () => {
    it('falls back to the default for unset, empty and non-numeric input', () => {
      expect(clampSqsWaitTimeSeconds(undefined)).to.equal(20)
      // Empty string must NOT become 0 — that would remove all pacing from
      // the receive loop and hot-loop against SQS.
      expect(clampSqsWaitTimeSeconds('')).to.equal(20)
      expect(clampSqsWaitTimeSeconds('   ')).to.equal(20)
      expect(clampSqsWaitTimeSeconds('abc')).to.equal(20)
    })

    it('floors at 1 to keep the receive loop paced', () => {
      expect(clampSqsWaitTimeSeconds('0')).to.equal(1)
      expect(clampSqsWaitTimeSeconds('-5')).to.equal(1)
    })

    it('caps at the SQS maximum of 20', () => {
      expect(clampSqsWaitTimeSeconds('30')).to.equal(20)
    })

    it('passes through valid values, flooring fractions', () => {
      expect(clampSqsWaitTimeSeconds('15')).to.equal(15)
      expect(clampSqsWaitTimeSeconds('7.9')).to.equal(7)
    })
  })

  describe('parseNonNegativeMilliseconds', () => {
    it('treats empty and whitespace input as absent, not zero', () => {
      // Number('') === 0 would silently disable the event-sync rate floor.
      expect(parseNonNegativeMilliseconds('', 10000)).to.equal(10000)
      expect(parseNonNegativeMilliseconds('   ', 10000)).to.equal(10000)
      expect(parseNonNegativeMilliseconds(undefined, 10000)).to.equal(10000)
    })

    it('honors an explicit zero as an opt-out', () => {
      expect(parseNonNegativeMilliseconds('0', 10000)).to.equal(0)
    })

    it('rejects negatives and garbage, floors fractions', () => {
      expect(parseNonNegativeMilliseconds('-5', 10000)).to.equal(10000)
      expect(parseNonNegativeMilliseconds('abc', 10000)).to.equal(10000)
      expect(parseNonNegativeMilliseconds('5000.9', 10000)).to.equal(5000)
    })
  })

  describe('regionFromSqsQueueUrl', () => {
    it('extracts the region from a standard queue URL', () => {
      expect(regionFromSqsQueueUrl('https://sqs.eu-central-1.amazonaws.com/123456789012/my-queue')).to.equal('eu-central-1')
    })

    it('returns null for URLs without a derivable region', () => {
      expect(regionFromSqsQueueUrl('http://localhost:4566/000000000000/kes-secrets-events')).to.equal(null)
      expect(regionFromSqsQueueUrl(undefined)).to.equal(null)
    })
  })
})
