'use strict'

const express = require('express')

/** MetricsServer class. */
class MetricsServer {
  /**
   * Create Metrics Server
   * @param {number} port  - the port to listen on
   * @param {Object} logger - Logger for logging stuff
   * @param {Object} register - Prometheus registry that holds metric data
   */
  constructor ({ port, logger, registry }) {
    this._port = port
    this._logger = logger
    this._registry = registry

    this._app = express()
    this._app.get('/metrics', async (req, res) => {
      try {
        res.set('Content-Type', this._registry.contentType)
        res.end(await this._registry.metrics())
      } catch (err) {
        this._logger.error('error collecting metrics: %s', err.message)
        res.status(500).end()
      }
    })
  }

  /**
   * Start the metrics server: Listen on a TCP port and serve metrics over HTTP
   */
  start () {
    return new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, () => {
        this._logger.info(`MetricsServer listening on port ${this._port}`)
        resolve()
      })
      this._server.on('error', err => reject(err))
    })
  }

  /**
   * Stop the metrics server
   */
  stop () {
    return new Promise((resolve, reject) => {
      this._server.close(err => {
        if (err) {
          return reject(err)
        }
        resolve()
      })
    })
  }
}

module.exports = MetricsServer
