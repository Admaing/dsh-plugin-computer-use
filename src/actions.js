/**
 * The Codex/OpenAI computer-tool action vocabulary.
 *
 * The action set and its field names deliberately mirror OpenAI's `computer`
 * tool (`screenshot`, `click`, `double_click`, `drag`, `move`, `scroll`,
 * `keypress`, `type`, `wait`) so a model already trained on that interface needs
 * no new vocabulary, and so batches are portable between harnesses.
 *
 * This module owns three things: the JSON-Schema spec the model sees, the
 * runtime validation that turns a model-supplied batch into canonical actions,
 * and the image-space → display-point mapping applied to every coordinate.
 *
 * @module dsh-plugin-computer-use/actions
 */

import { ACTION_TYPES } from './config.js'
import { imageToDisplayPoint } from './geometry.js'
import {
  asFiniteNumber,
  normalizeButton,
  normalizeChord,
  normalizeDragPath,
  normalizeModifiers,
} from './keys.js'

/** One branch of the discriminated union the model is offered. */
function branch(type, properties) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { type: { type: 'string', enum: [type] }, ...properties },
  }
}

/** `keys` holds modifier names to hold down during a pointer action. */
const MODIFIER_LIST = { type: 'array', items: { type: 'string' }, description: 'Modifier keys to hold during the action (e.g. ["cmd"], ["shift"]).' }

/** `x`/`y` are pixel coordinates in the previous screenshot. */
const X = { type: 'integer', required: true, description: 'X in pixels, measured on the most recent screenshot.' }
const Y = { type: 'integer', required: true, description: 'Y in pixels, measured on the most recent screenshot.' }

/**
 * The `actions` parameter spec handed to `defineTool`.
 *
 * `oneOf` gives the model a discriminated union, so each action's required
 * fields are visible in the schema rather than only in prose.
 */
export const ACTIONS_SCHEMA = Object.freeze({
  type: 'array',
  required: true,
  description:
    'Ordered actions to run in one batch. The screenshot is captured once, after the whole batch, so keep batches short (one to three actions) when a wrong assumption would be costly.',
  items: {
    oneOf: [
      branch('screenshot', {
        description: { type: 'string', description: 'Unused; present so the branch documents itself.' },
      }),
      branch('click', {
        x: X,
        y: Y,
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
        keys: MODIFIER_LIST,
      }),
      branch('double_click', { x: X, y: Y, keys: MODIFIER_LIST }),
      branch('move', { x: X, y: Y, keys: MODIFIER_LIST }),
      branch('drag', {
        path: {
          type: 'array',
          required: true,
          description: 'At least two [x, y] points in screenshot pixels; the drag presses at the first and releases at the last.',
          items: { type: 'array', items: { type: 'number' } },
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
        keys: MODIFIER_LIST,
      }),
      branch('scroll', {
        x: X,
        y: Y,
        scroll_x: { type: 'integer', required: true, description: 'Horizontal scroll amount; positive scrolls right. Use 0 for vertical-only scrolling.' },
        scroll_y: { type: 'integer', required: true, description: 'Vertical scroll amount; positive scrolls down. Use 0 for horizontal-only scrolling.' },
        keys: MODIFIER_LIST,
      }),
      branch('keypress', {
        keys: {
          type: 'array',
          required: true,
          description: 'A chord: modifier names plus exactly one key, e.g. ["CTRL","C"] or ["ENTER"].',
          items: { type: 'string' },
        },
      }),
      branch('type', {
        text: { type: 'string', required: true, description: 'Literal text to type, including spaces and newlines.' },
      }),
      branch('wait', {
        description: { type: 'string', description: 'Unused; present so the branch documents itself.' },
      }),
    ],
  },
})

/**
 * Whether an action changes the machine.
 *
 * `screenshot` is an observation, so a batch made only of screenshots can reuse
 * the capture taken to establish coordinates instead of taking a second one.
 *
 * @param {string} type - a canonical action type.
 * @returns {boolean} true when the action posts input events.
 */
export function isInputAction(type) {
  return type !== 'screenshot'
}

/**
 * Validate a model-supplied batch and canonicalise it.
 *
 * Every coordinate leaves this function in **global display points**, already
 * mapped out of the screenshot space the model measured in, and every key or
 * button name is in the native helper's canonical vocabulary.
 *
 * @param {unknown} rawActions - the model-supplied `actions` array.
 * @param {object} context - the resolved display, image and configuration.
 * @param {import('./geometry.js').DisplayFacts} context.display - display facts for the screenshot.
 * @param {import('./geometry.js').ImageFacts} context.image - the image the model received.
 * @param {import('./config.js').ComputerUseConfig} context.config - the resolved configuration.
 * @returns {Array<object>} canonical actions, in batch order.
 * @throws {Error} naming the offending action index and field.
 */
export function normalizeBatch(rawActions, context) {
  if (!Array.isArray(rawActions)) throw new Error('"actions" must be an array of action objects')
  if (rawActions.length === 0) throw new Error('"actions" must contain at least one action')
  const { maxActionsPerCall, allowedActions } = context.config
  if (rawActions.length > maxActionsPerCall) {
    throw new Error(
      `the batch has ${rawActions.length} actions but this deployment allows at most ${maxActionsPerCall} per call`,
    )
  }
  const actions = []
  for (const [index, raw] of rawActions.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`action ${index} must be an object`)
    }
    const type = raw.type
    if (typeof type !== 'string' || !ACTION_TYPES.includes(type)) {
      throw new Error(`action ${index} has unknown type "${String(type)}"; expected one of ${ACTION_TYPES.join(', ')}`)
    }
    if (allowedActions !== null && !allowedActions.includes(type)) {
      throw new Error(`action ${index} ("${type}") is not permitted: this deployment allows ${allowedActions.join(', ')}`)
    }
    try {
      // `label` preserves the model's own action name (`double_click`) even where
      // the canonical form collapses it (`click` with `count: 2`), so the
      // execution record reads back in the vocabulary the model used.
      actions.push({ ...normalizeAction(type, raw, context), label: type })
    } catch (error) {
      throw new Error(`action ${index} ("${type}"): ${error.message}`)
    }
  }
  return actions
}

/**
 * Canonicalise one action.
 *
 * @param {string} type - the validated action type.
 * @param {Record<string, unknown>} raw - the model-supplied action.
 * @param {object} context - display, image and configuration.
 * @returns {object} the canonical action.
 */
function normalizeAction(type, raw, context) {
  const { display, image, config } = context
  const point = (x, y) => imageToDisplayPoint(display, image, asFiniteNumber(x, 'x'), asFiniteNumber(y, 'y'))

  switch (type) {
    case 'screenshot':
      return { type: 'screenshot' }

    case 'move': {
      const at = point(raw.x, raw.y)
      return { type: 'move', x: at.x, y: at.y, modifiers: normalizeModifiers(raw.keys) }
    }

    case 'click':
    case 'double_click': {
      const at = point(raw.x, raw.y)
      return {
        type: 'click',
        x: at.x,
        y: at.y,
        button: normalizeButton(raw.button),
        count: type === 'double_click' ? 2 : 1,
        modifiers: normalizeModifiers(raw.keys),
      }
    }

    case 'drag': {
      const path = normalizeDragPath(raw.path).map(([x, y]) => {
        const at = point(x, y)
        return [at.x, at.y]
      })
      return {
        type: 'drag',
        path,
        button: normalizeButton(raw.button),
        modifiers: normalizeModifiers(raw.keys),
      }
    }

    case 'scroll': {
      const at = point(raw.x, raw.y)
      const scrollX = asFiniteNumber(raw.scroll_x, 'scroll_x')
      const scrollY = asFiniteNumber(raw.scroll_y, 'scroll_y')
      const direction = config.invertScroll ? -1 : 1
      // Codex counts scroll amounts as page movement: positive `scroll_y` moves
      // the view down. A CoreGraphics wheel delta counts the same way — a
      // positive wheel1 scrolls down — so the sign passes straight through. This
      // was measured, not assumed: posting +600 scrolled a 300-line document
      // from its first line to line 112, and -600 left it where it was.
      return {
        type: 'scroll',
        x: at.x,
        y: at.y,
        deltaX: Math.round(direction * scrollX),
        deltaY: Math.round(direction * scrollY),
        modifiers: normalizeModifiers(raw.keys),
      }
    }

    case 'keypress': {
      const chord = normalizeChord(raw.keys)
      return { type: 'keypress', key: chord.key, modifiers: chord.modifiers }
    }

    case 'type': {
      if (typeof raw.text !== 'string' || raw.text.length === 0) {
        throw new Error('"text" must be a non-empty string')
      }
      return { type: 'type', text: raw.text }
    }

    case 'wait':
      return { type: 'wait', ms: config.waitMs }

    default:
      throw new Error(`unsupported action "${type}"`)
  }
}

/**
 * The summary shown for an action the JavaScript side handles itself.
 *
 * Input actions are summarised by the native helper, which knows what it
 * actually posted; this covers only the observation the helper never sees.
 *
 * @param {object} action - a canonical action.
 * @returns {string} a short, model-facing record of the action.
 */
export function summarizeLocalAction(action) {
  return action.type === 'screenshot' ? 'capture the screen' : action.type
}
