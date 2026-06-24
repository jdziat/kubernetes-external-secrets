'use strict'

const {
  kubeClient,
  customResourceManifest
} = require('../../config')

const group = customResourceManifest.spec.group
const plural = customResourceManifest.spec.names.plural

/**
 * "delays" the async execution
 * @param {Number} ms - number of milliseconds to wait
 */
async function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * generate a uuid for this e2e run
 */
const uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)

/**
 * Create an ExternalSecret custom resource in a namespace.
 * @param {String} namespace
 * @param {Object} body - the ExternalSecret manifest
 * @returns {Promise<Object>} the created object
 */
const createExternalSecret = (namespace, body) =>
  kubeClient.customObjects.createNamespacedCustomObject({ group, version: 'v1', namespace, plural, body })

/**
 * wait for a secret to appear in a given namespace (polls up to ~3s)
 * @param {String} ns - namespace
 * @param {String} name - secret name
 * @return {Object|undefined} the Secret object (or undefined if it never appears)
 */
const waitForSecret = async (ns, name) => {
  for (let i = 0; i <= 30; i++) {
    try {
      return await kubeClient.core.readNamespacedSecret({ name, namespace: ns })
    } catch (e) {
      await delay(100)
    }
  }
}

module.exports = {
  uuid,
  delay,
  createExternalSecret,
  waitForSecret
}
