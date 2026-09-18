/**
 * Configuration for the `computer` tool.
 *
 * The plugin deliberately declares no `Config` schema: it has no runtime
 * dependencies, and a hand-written validator keeps that true while still
 * rejecting a bad composition row with a message that names the exact field.
 *
 * @module dsh-plugin-computer-use/config
 */

/**
 * @typedef {object} ComputerUseConfig
 * @property {boolean} enabled - whether the tool is registered at all.
 * @property {'auto'|'native'|'applescript'} backend - which input backend to use.
 * @property {number} display - 0-based index of the display to drive.
 * @property {number} maxActionsPerCall - upper bound on one action batch.
 * @property {number} waitMs - duration of a `wait` action.
 * @property {number} settleMs - pause after a batch, before the result screenshot.
 * @property {string[]|null} allowedActions - permitted action types, or null for all.
 * @property {boolean} invertScroll - flip the sign convention for scroll deltas.
 * @property {string|null} helperCacheDir - where the compiled helper is cached.
 * @property {boolean} requireImageCapableModel - refuse when the route cannot see images.
 */

/** Every field's default, applied before validation. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  backend: 'auto',
  display: 0,
  maxActionsPerCall: 25,
  waitMs: 2000,
  settleMs: 250,
  allowedActions: null,
  invertScroll: false,
  helperCacheDir: null,
  requireImageCapableModel: true,
})

/** The action types the tool can execute. */
export const ACTION_TYPES = Object.freeze([
  'screenshot',
  'click',
  'double_click',
  'drag',
  'move',
  'scroll',
  'keypress',
  'type',
  'wait',
])

/**
 * Merge user configuration over the defaults and validate the result.
 *
 * @param {unknown} raw - the composition row's `config` block, if any.
 * @returns {ComputerUseConfig} the validated configuration.
 * @throws {Error} naming the first invalid field.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('computer-use config must be a mapping')
  }
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(raw ?? {})) {
    if (!known.has(key)) {
      throw new Error(`computer-use config has unknown field "${key}"; known fields: ${[...known].join(', ')}`)
    }
  }
  if (typeof config.enabled !== 'boolean') throw new Error('computer-use config "enabled" must be a boolean')
  if (!['auto', 'native', 'applescript'].includes(config.backend)) {
    throw new Error('computer-use config "backend" must be "auto", "native" or "applescript"')
  }
  if (!Number.isInteger(config.display) || config.display < 0) {
    throw new Error('computer-use config "display" must be a non-negative integer')
  }
  if (!Number.isInteger(config.maxActionsPerCall) || config.maxActionsPerCall < 1) {
    throw new Error('computer-use config "maxActionsPerCall" must be a positive integer')
  }
  for (const field of ['waitMs', 'settleMs']) {
    if (!Number.isFinite(config[field]) || config[field] < 0) {
      throw new Error(`computer-use config "${field}" must be a non-negative number`)
    }
  }
  if (config.allowedActions !== null) {
    if (!Array.isArray(config.allowedActions) || config.allowedActions.length === 0) {
      throw new Error('computer-use config "allowedActions" must be null or a non-empty array of action types')
    }
    for (const action of config.allowedActions) {
      if (!ACTION_TYPES.includes(action)) {
        throw new Error(`computer-use config "allowedActions" contains unknown action "${String(action)}"; known actions: ${ACTION_TYPES.join(', ')}`)
      }
    }
  }
  if (config.helperCacheDir !== null && (typeof config.helperCacheDir !== 'string' || config.helperCacheDir.length === 0)) {
    throw new Error('computer-use config "helperCacheDir" must be null or a non-empty path')
  }
  if (typeof config.invertScroll !== 'boolean') {
    throw new Error('computer-use config "invertScroll" must be a boolean')
  }
  if (typeof config.requireImageCapableModel !== 'boolean') {
    throw new Error('computer-use config "requireImageCapableModel" must be a boolean')
  }
  return config
}
