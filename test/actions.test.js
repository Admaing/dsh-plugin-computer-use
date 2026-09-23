import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeBatch } from '../src/actions.js'
import { DEFAULT_CONFIG } from '../src/config.js'

/** A 1:1 display so image coordinates and display points coincide. */
const DISPLAY = {
  originX: 0,
  originY: 0,
  widthPoints: 1000,
  heightPoints: 800,
  widthPixels: 1000,
  heightPixels: 800,
  backingScale: 1,
}

/** The image the model received after the attachment service downscaled it 2x. */
const DOWNSCALED_IMAGE = { width: 500, height: 400 }

/**
 * Normalise a batch against a fixed context.
 *
 * @param {object[]} actions - the model-supplied batch.
 * @param {object} [overrides] - context overrides.
 * @returns {object[]} the canonical actions.
 */
function normalize(actions, overrides = {}) {
  return normalizeBatch(actions, {
    display: DISPLAY,
    image: { width: 1000, height: 800 },
    config: DEFAULT_CONFIG,
    ...overrides,
  })
}

describe('normalizeBatch', () => {
  it('keeps the batch order', () => {
    const actions = normalize([{ type: 'move', x: 1, y: 2 }, { type: 'click', x: 3, y: 4 }])
    assert.deepEqual(actions.map((action) => action.type), ['move', 'click'])
  })

  it('labels each action with the model’s own name', () => {
    const [action] = normalize([{ type: 'double_click', x: 5, y: 5 }])
    // Canonically a click with count 2, but reported back as what was asked for.
    assert.equal(action.type, 'click')
    assert.equal(action.count, 2)
    assert.equal(action.label, 'double_click')
  })

  it('rejects an empty or non-array batch', () => {
    assert.throws(() => normalize([]), /at least one action/)
    assert.throws(() => normalize('screenshot'), /must be an array/)
  })

  it('names the offending index and type', () => {
    assert.throws(() => normalize([{ type: 'move', x: 0, y: 0 }, { type: 'teleport' }]), /action 1 has unknown type "teleport"/)
    assert.throws(() => normalize([{ type: 'move', x: 0, y: 0 }, { type: 'click', x: 1 }]), /action 1 \("click"\): "y" must be a finite number/)
    assert.throws(() => normalize([null]), /action 0 must be an object/)
  })

  it('enforces the per-call batch limit', () => {
    const many = Array.from({ length: 3 }, () => ({ type: 'screenshot' }))
    assert.throws(
      () => normalize(many, { config: { ...DEFAULT_CONFIG, maxActionsPerCall: 2 } }),
      /has 3 actions but this deployment allows at most 2/,
    )
  })

  it('enforces an allow-list when the deployment sets one', () => {
    const config = { ...DEFAULT_CONFIG, allowedActions: ['screenshot', 'click'] }
    assert.doesNotThrow(() => normalize([{ type: 'click', x: 0, y: 0 }], { config }))
    assert.throws(() => normalize([{ type: 'type', text: 'hi' }], { config }), /is not permitted/)
  })
})

describe('coordinate mapping', () => {
  it('maps a 1:1 screenshot straight through', () => {
    const [action] = normalize([{ type: 'click', x: 405, y: 157 }])
    assert.equal(action.x, 405)
    assert.equal(action.y, 157)
  })

  it('maps a downscaled screenshot onto display points', () => {
    // The display is 1000x800 points; the model measured on a 500x400 image,
    // so one image pixel is two display points.
    const [action] = normalize([{ type: 'click', x: 405, y: 157 }], { image: DOWNSCALED_IMAGE })
    assert.equal(action.x, 810)
    assert.equal(action.y, 314)
  })

  it('maps every point of a drag path', () => {
    const [action] = normalize([{ type: 'drag', path: [[0, 0], [100, 50]] }], { image: DOWNSCALED_IMAGE })
    assert.deepEqual(action.path, [[0, 0], [200, 100]])
  })

  it('maps the scroll anchor and keeps the deltas', () => {
    const [action] = normalize([{ type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 100 }])
    assert.equal(action.x, 10)
    assert.equal(action.y, 20)
    // Positive `scroll_y` (down) stays positive: CoreGraphics wheel deltas use
    // the same sign. See the scroll sign convention suite for the measurement.
    assert.equal(action.deltaY, 100)
  })
})

describe('action canonicalisation', () => {
  it('defaults the button to left and honours an explicit one', () => {
    assert.equal(normalize([{ type: 'click', x: 0, y: 0 }])[0].button, 'left')
    assert.equal(normalize([{ type: 'click', x: 0, y: 0, button: 'right' }])[0].button, 'right')
  })

  it('attaches modifiers to pointer actions', () => {
    assert.deepEqual(normalize([{ type: 'click', x: 0, y: 0, keys: ['CMD'] }])[0].modifiers, ['command'])
  })

  it('turns a keypress chord into one key plus flags', () => {
    const [action] = normalize([{ type: 'keypress', keys: ['CTRL', 'SHIFT', 'C'] }])
    assert.equal(action.key, 'c')
    assert.deepEqual(action.modifiers, ['control', 'shift'])
  })

  it('keeps typed text verbatim, including spaces and newlines', () => {
    const text = 'hello world\nsecond line\t"quoted"'
    assert.equal(normalize([{ type: 'type', text }])[0].text, text)
  })

  it('refuses empty typed text', () => {
    assert.throws(() => normalize([{ type: 'type', text: '' }]), /"text" must be a non-empty string/)
  })

  it('gives wait the configured duration', () => {
    assert.equal(normalize([{ type: 'wait' }])[0].ms, DEFAULT_CONFIG.waitMs)
    assert.equal(normalize([{ type: 'wait' }], { config: { ...DEFAULT_CONFIG, waitMs: 250 } })[0].ms, 250)
  })

  it('passes a screenshot through unchanged', () => {
    assert.deepEqual(normalize([{ type: 'screenshot' }])[0], { type: 'screenshot', label: 'screenshot' })
  })
})

describe('scroll sign convention', () => {
  it('passes Codex deltas straight through, because CoreGraphics counts the same way', () => {
    // Codex: positive scroll_y moves the view down. Measured on macOS: posting
    // wheel1 = +600 scrolled a 300-line document from line 1 to line 112, while
    // wheel1 = -600 left it where it was. So the sign passes through unchanged —
    // an earlier version negated it here and scrolled the wrong way.
    const [down] = normalize([{ type: 'scroll', x: 0, y: 0, scroll_x: 0, scroll_y: 120 }])
    assert.equal(down.deltaY, 120)
    const [up] = normalize([{ type: 'scroll', x: 0, y: 0, scroll_x: 0, scroll_y: -120 }])
    assert.equal(up.deltaY, -120)
  })

  it('can be inverted for a deployment that disagrees', () => {
    const [action] = normalize([{ type: 'scroll', x: 0, y: 0, scroll_x: 0, scroll_y: 120 }], {
      config: { ...DEFAULT_CONFIG, invertScroll: true },
    })
    assert.equal(action.deltaY, -120)
  })

  it('passes horizontal deltas through too', () => {
    const [action] = normalize([{ type: 'scroll', x: 0, y: 0, scroll_x: 60, scroll_y: 0 }])
    assert.equal(action.deltaX, 60)
  })
})
