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
 * candidate names it may be known by. Only ARN resources get the random
 * "-XXXXXX" suffix stripped — a plain name is taken literally, so a spec key
 * like "app/creds-master" is never also indexed as "app/creds". Stripping an
 * ARN is still ambiguous for friendly names that genuinely end in a
 * six-char suffix, so both forms are returned (over-trigger, never miss).
 * @param {string} idOrArn - secret name or ARN.
 * @returns {string[]} deduped candidate names.
 */
const expandSecretKeyCandidates = (idOrArn) => {
  if (typeof idOrArn !== 'string' || idOrArn === '') return []

  const arnMatch = SECRETS_MANAGER_ARN_RE.exec(idOrArn)
  if (!arnMatch) return [idOrArn]

  const resource = arnMatch[1]
  const candidates = new Set([resource])
  if (RANDOM_SUFFIX_RE.test(resource)) {
    const stripped = resource.replace(RANDOM_SUFFIX_RE, '')
    if (stripped !== '') candidates.add(stripped)
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

/**
 * Clamp an SQS long-poll wait time to a safe range. SQS accepts 0-20, but 0
 * turns the consumer's receive loop into an unpaced hot loop on an empty
 * queue, so the floor is 1. Empty/whitespace/non-numeric input (an unset or
 * mis-templated env var) falls back to the default.
 * @param {string|undefined} raw - raw env var value.
 * @param {number} defaultSeconds - value used when raw is absent or invalid.
 * @returns {number} wait time in seconds, within [1, 20].
 */
const clampSqsWaitTimeSeconds = (raw, defaultSeconds = 20) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const parsed = trimmed === '' ? NaN : Number(trimmed)
  if (!Number.isFinite(parsed)) return defaultSeconds
  return Math.min(Math.max(Math.floor(parsed), 1), 20)
}

/**
 * Parse a non-negative integer duration from an env var. Empty/whitespace
 * input is treated as absent (Number('') is 0, which would silently disable
 * a rate limit); an explicit "0" is honored as an opt-out.
 * @param {string|undefined} raw - raw env var value.
 * @param {number} defaultValue - value used when raw is absent or invalid.
 * @returns {number} parsed value or the default.
 */
const parseNonNegativeMilliseconds = (raw, defaultValue) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const parsed = trimmed === '' ? NaN : Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : defaultValue
}

const SQS_URL_REGION_RE = /^https?:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?\//

/**
 * Derive the AWS region from an SQS queue URL so the SQS client always talks
 * to the queue's region even when AWS_REGION points elsewhere. Returns null
 * for URLs that don't carry a region (e.g. LocalStack).
 * @param {string} queueUrl - SQS queue URL.
 * @returns {?string} region or null.
 */
const regionFromSqsQueueUrl = (queueUrl) => {
  if (typeof queueUrl !== 'string') return null
  const match = SQS_URL_REGION_RE.exec(queueUrl)
  return match ? match[1] : null
}

module.exports = {
  compileTemplate,
  compileObjectTemplateKeys,
  collectSpecSecretEntries,
  expandSecretKeyCandidates,
  collectSecretsManagerIndexNames,
  clampSqsWaitTimeSeconds,
  parseNonNegativeMilliseconds,
  regionFromSqsQueueUrl
}
