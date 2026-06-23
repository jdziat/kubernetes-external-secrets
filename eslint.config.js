'use strict'

const neostandard = require('neostandard')
const security = require('eslint-plugin-security')
const globals = require('globals')

module.exports = [
  { ignores: ['coverage/', 'e2e/'] },
  ...neostandard(),
  security.configs.recommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      strict: 'off'
    }
  },
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: { ...globals.mocha }
    }
  }
]
