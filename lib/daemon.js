'use strict'

const { collectSecretsManagerIndexNames } = require('./utils')

/** Daemon class. */
class Daemon {
  /**
   * Create daemon.
   * @param {Object} backends - Backends for fetching secret properties.
   * @param {Object} kubeClient - Client for interacting with kubernetes cluster.
   * @param {Object} externalSecretEvents - Stream of external secret events.
   * @param {Object} logger - Logger for logging stuff.
   * @param {number} pollerIntervalMilliseconds - Interval time in milliseconds for polling secret properties.
   */
  constructor ({
    instanceId,
    externalSecretEvents,
    logger,
    pollerFactory
  }) {
    this._instanceId = instanceId
    this._externalSecretEvents = externalSecretEvents
    this._logger = logger
    this._pollerFactory = pollerFactory

    this._pollers = {}
    // Reverse index for event-driven sync: candidate secret name -> Set<pollerId>,
    // plus pollerId -> candidate names for cleanup on removal.
    this._secretNameIndex = new Map()
    this._pollerSecretNames = new Map()
  }

  /**
   * Create a poller descriptor from externalsecret resources.
   * @param {Object} object - externalsecret manifest.
   * @returns {Object} Poller descriptor.
   */
  _createPollerDescriptor (externalSecret) {
    const { uid, name, namespace } = externalSecret.metadata

    return { id: uid, name, namespace, externalSecret }
  }

  /**
   * Remove a poller associated with a deleted or modified externalsecret.
   * @param {String} pollerId - ID of the poller to remove.
   */
  _removePoller (pollerId) {
    if (this._pollers[pollerId]) {
      this._logger.debug(`stopping and removing poller ${pollerId}`)
      this._unindexPoller(pollerId)
      this._pollers[pollerId].stop()
      delete this._pollers[pollerId]
    }
  }

  _removePollers () {
    Object.keys(this._pollers).forEach(pollerId => this._removePoller(pollerId))
  }

  _addPoller (descriptor) {
    this._logger.debug(`spinning up poller for ${descriptor.namespace}/${descriptor.name}`)

    const poller = this._pollerFactory.createPoller(descriptor)

    this._pollers[descriptor.id] = poller.start()
    this._indexPoller(descriptor)
  }

  _indexPoller (descriptor) {
    const spec = descriptor.externalSecret.spec || descriptor.externalSecret.secretDescriptor
    const names = collectSecretsManagerIndexNames(spec)
    if (names.length === 0) return

    this._pollerSecretNames.set(descriptor.id, names)
    names.forEach((name) => {
      if (!this._secretNameIndex.has(name)) {
        this._secretNameIndex.set(name, new Set())
      }
      this._secretNameIndex.get(name).add(descriptor.id)
    })
  }

  _unindexPoller (pollerId) {
    const names = this._pollerSecretNames.get(pollerId)
    if (!names) return

    names.forEach((name) => {
      const ids = this._secretNameIndex.get(name)
      if (!ids) return
      ids.delete(pollerId)
      if (ids.size === 0) {
        this._secretNameIndex.delete(name)
      }
    })
    this._pollerSecretNames.delete(pollerId)
  }

  /**
   * Look up live pollers whose ExternalSecret references the given
   * Secrets Manager candidate name.
   * @param {String} name - normalized secret name candidate.
   * @returns {Object[]} matching pollers.
   */
  getPollersForSecretName (name) {
    const ids = this._secretNameIndex.get(name)
    if (!ids) return []
    return [...ids].map((id) => this._pollers[id]).filter(Boolean)
  }

  /**
   * Start daemon and create pollers.
   */
  async start () {
    for await (const event of this._externalSecretEvents) {
      // Check if the externalSecret should be managed by this instance.
      if (event.object && event.object.spec) {
        const externalSecretMetadata = event.object.metadata
        const externalSecretController = event.object.spec.controllerId
        if ((this._instanceId || externalSecretController) && this._instanceId !== externalSecretController) {
          this._logger.debug('the secret %s/%s is not managed by this instance but by %s',
            externalSecretMetadata.namespace, externalSecretMetadata.name, externalSecretController)
          continue
        }
      }

      const descriptor = event.object ? this._createPollerDescriptor(event.object) : null

      switch (event.type) {
        case 'DELETED': {
          this._removePoller(descriptor.id)
          break
        }

        case 'ADDED':
        case 'MODIFIED': {
          this._removePoller(descriptor.id)
          this._addPoller(descriptor)
          break
        }

        case 'DELETED_ALL': {
          this._removePollers()
          break
        }

        default: {
          this._logger.warn(event, 'Unhandled event type %s', event.type)
          break
        }
      }
    }
  }

  /**
   * Destroy pollers and stop deamon.
   */
  stop () {
    this._removePollers()
    this._externalSecretEvents.return(null)
  }
}

module.exports = Daemon
