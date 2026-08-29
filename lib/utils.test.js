'use strict'

const { expect } = require('chai')

const {
  collectSpecSecretEntries,
  expandSecretKeyCandidates,
  collectSecretsManagerIndexNames
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

    it('returns a plain name as-is when no suffix matches', () => {
      expect(expandSecretKeyCandidates('demo-service/credentials')).to.deep.equal(['demo-service/credentials'])
    })

    it('returns both forms for a name ending in a suffix-like segment', () => {
      expect(expandSecretKeyCandidates('my-secret-Ab1234')).to.deep.equal([
        'my-secret-Ab1234',
        'my-secret'
      ])
    })

    it('handles an ARN whose resource has no strippable suffix', () => {
      expect(expandSecretKeyCandidates('arn:aws:secretsmanager:eu-west-1:123456789012:secret:short')).to.deep.equal(['short'])
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
          { key: 'app/db-Ab1234', name: 'x' },
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
})
