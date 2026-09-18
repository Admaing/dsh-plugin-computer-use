import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACTION_TYPES, DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies every default when the row carries no config', () => {
    assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
    assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
    assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
  })

  it('overlays supplied fields on the defaults', () => {
    const config = resolveConfig({ display: 1, backend: 'applescript' })
    assert.equal(config.display, 1)
    assert.equal(config.backend, 'applescript')
    assert.equal(config.maxActionsPerCall, DEFAULT_CONFIG.maxActionsPerCall)
  })

  it('rejects an unknown field rather than ignoring it', () => {
    // A typo in a composition row must fail loudly; silently keeping the default
    // is how a deployment ends up believing it disabled something it did not.
    assert.throws(() => resolveConfig({ maxActionPerCall: 5 }), /unknown field "maxActionPerCall"/)
  })

  it('rejects a non-mapping config', () => {
    assert.throws(() => resolveConfig('nope'), /must be a mapping/)
    assert.throws(() => resolveConfig([1, 2]), /must be a mapping/)
  })

  it('validates the backend name', () => {
    assert.throws(() => resolveConfig({ backend: 'linux' }), /"backend" must be "auto", "native" or "applescript"/)
  })

  it('validates numeric fields', () => {
    assert.throws(() => resolveConfig({ display: -1 }), /"display" must be a non-negative integer/)
    assert.throws(() => resolveConfig({ display: 1.5 }), /"display" must be a non-negative integer/)
    assert.throws(() => resolveConfig({ maxActionsPerCall: 0 }), /"maxActionsPerCall" must be a positive integer/)
    assert.throws(() => resolveConfig({ settleMs: -5 }), /"settleMs" must be a non-negative number/)
    assert.throws(() => resolveConfig({ waitMs: 'soon' }), /"waitMs" must be a non-negative number/)
  })

  it('validates the allow-list against the real action set', () => {
    assert.deepEqual(resolveConfig({ allowedActions: ['screenshot', 'click'] }).allowedActions, ['screenshot', 'click'])
    assert.throws(() => resolveConfig({ allowedActions: [] }), /null or a non-empty array/)
    assert.throws(() => resolveConfig({ allowedActions: ['teleport'] }), /unknown action "teleport"/)
  })

  it('validates the boolean fields', () => {
    assert.throws(() => resolveConfig({ enabled: 'yes' }), /"enabled" must be a boolean/)
    assert.throws(() => resolveConfig({ invertScroll: 1 }), /"invertScroll" must be a boolean/)
    assert.throws(() => resolveConfig({ requireImageCapableModel: 'no' }), /"requireImageCapableModel" must be a boolean/)
  })

  it('accepts a helper cache directory', () => {
    assert.equal(resolveConfig({ helperCacheDir: '/tmp/helpers' }).helperCacheDir, '/tmp/helpers')
    assert.throws(() => resolveConfig({ helperCacheDir: '' }), /"helperCacheDir" must be null or a non-empty path/)
  })
})

describe('ACTION_TYPES', () => {
  it('is exactly the Codex computer-tool action set', () => {
    assert.deepEqual(
      [...ACTION_TYPES].sort(),
      ['click', 'double_click', 'drag', 'keypress', 'move', 'screenshot', 'scroll', 'type', 'wait'],
    )
  })
})
