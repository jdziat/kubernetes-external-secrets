const yaml = require('js-yaml')
const parseTemplate = require('lodash/template')
const mapValues = require('lodash/mapValues')

const compileTemplate = (template, data) => parseTemplate(template, { imports: { yaml }, variable: 'data' })(data)

const compileObjectTemplateKeys = (object, data) => {
  return mapValues(object, (value) => {
    if (value) {
      const valueType = typeof value

      if (valueType === 'string') {
        return compileTemplate(value, data)
      } else if (valueType === 'object' && !Array.isArray(value)) {
        return compileObjectTemplateKeys(value, data)
      }
    }

    return value
  })
}

const SECRETS_MANAGER_ARN_RE = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/
// Secrets Manager appends "-XXXXXX" (6 random chars) to the friendly name in ARNs.
const RANDOM_SUFFIX_RE = /-[A-Za-z0-9]{6}$/

/**
 * Collect every backend secret reference from an ExternalSecret spec.
 * @param {Object} spec - ExternalSecret spec (or legacy secretDescriptor).
 * @returns {Object[]} entries of shape { source, key?, path?, versionId? }
 */
const collectSpecSecretEntries = (spec) => {
  const entries = []
  if (!spec || typeof spec !== 'object') return entries

  const data = spec.data || spec.properties
  if (Array.isArray(data)) {
    data.forEach((item) => {
      if (item && typeof item === 'object') {
        entries.push({
          source: 'data',
          key: item.key,
          path: item.path,
          versionId: item.versionId
        })
      }
    })
  }

  if (Array.isArray(spec.dataFrom)) {
    spec.dataFrom.forEach((key) => {
      entries.push({ source: 'dataFrom', key })
    })
  }

  if (Array.isArray(spec.dataFromWithOptions)) {
    spec.dataFromWithOptions.forEach((item) => {
      if (item && typeof item === 'object') {
        entries.push({
          source: 'dataFromWithOptions',
          key: item.key,
          versionId: item.versionId
        })
      }
    })
  }

  return entries
}

/**
 * Expand a Secrets Manager secret id (friendly name or full ARN) into the
 * candidate names it may be known by. ARNs carry a random "-XXXXXX" suffix on
 * the friendly name; since stripping it is ambiguous for names that genuinely
 * end that way, both forms are returned so matching over-triggers rather than
 * misses.
 * @param {string} idOrArn - secret name or ARN.
 * @returns {string[]} deduped candidate names.
 */
const expandSecretKeyCandidates = (idOrArn) => {
  if (typeof idOrArn !== 'string' || idOrArn === '') return []

  const arnMatch = SECRETS_MANAGER_ARN_RE.exec(idOrArn)
  const name = arnMatch ? arnMatch[1] : idOrArn

  const candidates = new Set([name])
  if (RANDOM_SUFFIX_RE.test(name)) {
    candidates.add(name.replace(RANDOM_SUFFIX_RE, ''))
  }

  return [...candidates]
}

const SECRETS_MANAGER_BACKEND_TYPES = new Set(['secretsManager', 'secretManager'])

/**
 * Collect the candidate Secrets Manager names an ExternalSecret spec should be
 * indexed under for event-driven sync. Non-Secrets-Manager backends return
 * nothing, and entries pinned to a versionId are excluded (a change event can
 * never alter what a pinned version resolves to).
 * @param {Object} spec - ExternalSecret spec.
 * @returns {string[]} deduped candidate names.
 */
const collectSecretsManagerIndexNames = (spec) => {
  if (!spec || !SECRETS_MANAGER_BACKEND_TYPES.has(spec.backendType)) return []

  const names = new Set()
  collectSpecSecretEntries(spec).forEach((entry) => {
    if (entry.versionId || !entry.key) return
    expandSecretKeyCandidates(entry.key).forEach((candidate) => names.add(candidate))
  })

  return [...names]
}

module.exports = {
  compileTemplate,
  compileObjectTemplateKeys,
  collectSpecSecretEntries,
  expandSecretKeyCandidates,
  collectSecretsManagerIndexNames
}
