/**
 * Key, button and drag-path normalisation.
 *
 * The model speaks the OpenAI/Codex computer-tool vocabulary (`ENTER`, `CMD`,
 * `PAGEUP`, …). The native helper speaks canonical macOS names (`return`,
 * `command`, `pageup`). This module is the only place that knows both, so the
 * helper stays a mechanical lookup table.
 *
 * @module dsh-plugin-computer-use/keys
 */

/**
 * OpenAI/Codex key names mapped to their canonical macOS equivalents.
 *
 * `DELETE` maps to forward-delete rather than backspace: that is what the
 * reference Playwright and xdotool handlers do, and the Codex action set uses
 * `BACKSPACE` for the other key.
 */
const KEY_ALIASES = Object.freeze({
  ENTER: 'return',
  RETURN: 'return',
  ESC: 'escape',
  ESCAPE: 'escape',
  TAB: 'tab',
  SPACE: 'space',
  BACKSPACE: 'delete',
  DELETE: 'forwarddelete',
  DEL: 'forwarddelete',
  HOME: 'home',
  END: 'end',
  PAGEUP: 'pageup',
  PGUP: 'pageup',
  PAGEDOWN: 'pagedown',
  PGDN: 'pagedown',
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  ARROWUP: 'up',
  ARROWDOWN: 'down',
  ARROWLEFT: 'left',
  ARROWRIGHT: 'right',
  CTRL: 'control',
  CONTROL: 'control',
  SHIFT: 'shift',
  OPTION: 'option',
  ALT: 'option',
  META: 'command',
  CMD: 'command',
  COMMAND: 'command',
  CAPSLOCK: 'capslock',
  FN: 'function',
})

/** Names that hold a modifier down for the duration of another action. */
const MODIFIER_NAMES = new Set([
  'command',
  'cmd',
  'meta',
  'super',
  'shift',
  'option',
  'alt',
  'opt',
  'control',
  'ctrl',
  'fn',
  'function',
])

/**
 * Canonicalise one key name.
 *
 * Single characters (`a`, `1`, `/`) and function keys (`F1`…`F20`) pass through
 * lowercased; known Codex aliases resolve through {@link KEY_ALIASES}.
 *
 * @param {unknown} value - the model-supplied key name.
 * @returns {string} the canonical macOS key name.
 * @throws {Error} when the value is not a non-empty string.
 */
export function normalizeKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('a key name must be a non-empty string')
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error('a key name must be a non-empty string')
  const upper = trimmed.toUpperCase()
  const alias = KEY_ALIASES[upper]
  if (alias !== undefined) return alias
  if (/^F([1-9]|1[0-9]|20)$/.test(upper)) return upper.toLowerCase()
  return trimmed.toLowerCase()
}

/**
 * Whether a canonical key name is a modifier rather than a key to press.
 *
 * @param {string} name - a canonical key name.
 * @returns {boolean} true when the name denotes a modifier.
 */
export function isModifierKey(name) {
  return MODIFIER_NAMES.has(name)
}

/**
 * Split a Codex `keypress` key list into modifiers plus one key to press.
 *
 * Codex expresses chords as an array (`["CTRL", "C"]`). macOS needs the
 * modifiers as event flags and exactly one virtual key code, so the last
 * non-modifier entry becomes the key and every modifier becomes a flag.
 *
 * @param {unknown} keys - the model-supplied key list.
 * @returns {{key: string, modifiers: string[]}} the canonical chord.
 * @throws {Error} when the list holds no pressable key.
 */
export function normalizeChord(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keypress requires a non-empty "keys" array')
  }
  const modifiers = []
  let key
  for (const entry of keys) {
    const name = normalizeKey(entry)
    if (isModifierKey(name)) {
      if (!modifiers.includes(name)) modifiers.push(name)
      continue
    }
    key = name
  }
  if (key === undefined) {
    throw new Error(
      `keypress needs one non-modifier key; got only ${keys.map((entry) => String(entry)).join(', ')}`,
    )
  }
  return { key, modifiers }
}

/**
 * Canonicalise a mouse button name.
 *
 * @param {unknown} value - the model-supplied button name, or undefined.
 * @returns {string} one of `left`, `right`, `middle`.
 */
export function normalizeButton(value) {
  if (value === undefined || value === null) return 'left'
  if (typeof value !== 'string') throw new Error('"button" must be a string')
  switch (value.trim().toLowerCase()) {
    case '':
    case 'left':
      return 'left'
    case 'right':
      return 'right'
    case 'middle':
    case 'center':
    case 'wheel':
      return 'middle'
    default:
      throw new Error(`unsupported mouse button "${value}"; use left, right or middle`)
  }
}

/**
 * Canonicalise modifier names attached to a pointer action.
 *
 * @param {unknown} value - the model-supplied `keys` list, or undefined.
 * @returns {string[]} canonical modifier names, without duplicates.
 */
export function normalizeModifiers(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('"keys" must be an array of key names')
  const modifiers = []
  for (const entry of value) {
    const name = normalizeKey(entry)
    if (!isModifierKey(name)) {
      throw new Error(`"${String(entry)}" is not a modifier key`)
    }
    if (!modifiers.includes(name)) modifiers.push(name)
  }
  return modifiers
}

/**
 * Canonicalise a drag path.
 *
 * The Codex schema accepts either `[x, y]` pairs or `{x, y}` objects; both are
 * reduced to pairs here.
 *
 * @param {unknown} value - the model-supplied path.
 * @returns {Array<[number, number]>} the canonical path.
 * @throws {Error} when fewer than two usable points are supplied.
 */
export function normalizeDragPath(value) {
  if (!Array.isArray(value)) throw new Error('drag requires a "path" array')
  const path = value.map((point) => {
    if (Array.isArray(point) && point.length >= 2) return [asFiniteNumber(point[0], 'path x'), asFiniteNumber(point[1], 'path y')]
    if (point !== null && typeof point === 'object' && 'x' in point && 'y' in point) {
      return [asFiniteNumber(point.x, 'path x'), asFiniteNumber(point.y, 'path y')]
    }
    throw new Error('each drag path entry must be an [x, y] pair or an {x, y} object')
  })
  if (path.length < 2) throw new Error('drag requires at least two path points')
  return path
}

/**
 * Require a finite number.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - the field name used in the error message.
 * @returns {number} the value as a number.
 */
export function asFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${label}" must be a finite number`)
  }
  return value
}
