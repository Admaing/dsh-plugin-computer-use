/**
 * The AppleScript fallback backend.
 *
 * This exists for machines without the Xcode Command Line Tools, where the
 * native helper cannot be compiled. It drives `System Events` through
 * `osascript` and captures with `screencapture`, so it needs no toolchain — but
 * it is a genuinely reduced backend, and it says so rather than pretending
 * otherwise:
 *
 * - only the **main display** is addressable (`System Events` has no per-display
 *   coordinate space, and Finder reports the union of all desktops);
 * - `move`, `drag` and `scroll` have no AppleScript equivalent and are refused;
 * - it needs Accessibility permission for `System Events`, not just the parent
 *   process.
 *
 * @module dsh-plugin-computer-use/backends/applescript
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runFile, which } from '../exec.js'
import { readPngSize } from '../png.js'

/** The system capture utility, shared with the native backend. */
const SCREENCAPTURE = '/usr/sbin/screencapture'

/** AppleScript key codes for the canonical names that are not single characters. */
const KEY_CODES = Object.freeze({
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  forwarddelete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
})

/** Canonical modifier names mapped to their AppleScript `using` clause. */
const MODIFIER_CLAUSES = Object.freeze({
  command: 'command down',
  shift: 'shift down',
  option: 'option down',
  control: 'control down',
})

/** Actions this backend can actually perform. */
const SUPPORTED = new Set(['click', 'keypress', 'type', 'wait'])

/**
 * Escape one string for embedding in an AppleScript literal.
 *
 * @param {string} value - the raw text.
 * @returns {string} the escaped text.
 */
function escapeAppleScript(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Run one AppleScript snippet.
 *
 * @param {string} script - the script source.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} the script's stdout, trimmed.
 */
async function osascript(script, signal) {
  const binary = (await which('osascript')) ?? '/usr/bin/osascript'
  const { stdout } = await runFile(binary, ['-e', script], { signal, timeoutMs: 60_000 })
  return stdout.trim()
}

/**
 * Report display and permission facts.
 *
 * `screenCaptureAllowed` is null here: AppleScript cannot preflight Screen
 * Recording, so the honest answer is "unknown" and the first capture reports it.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{displays: object[], accessibilityTrusted: boolean, screenCaptureAllowed: null}>} probe facts.
 */
export async function probe(config, signal) {
  const bounds = await osascript('tell application "Finder" to get bounds of window of desktop', signal)
  const numbers = bounds.split(',').map((part) => Number(part.trim()))
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) {
    throw new Error(`the AppleScript backend could not read the desktop bounds (got "${bounds}")`)
  }
  const [left, top, right, bottom] = numbers
  let accessibilityTrusted = false
  try {
    const enabled = await osascript('tell application "System Events" to get UI elements enabled', signal)
    accessibilityTrusted = enabled.toLowerCase() === 'true'
  } catch {
    // A refusal here *is* the answer: System Events is not permitted.
    accessibilityTrusted = false
  }
  return {
    displays: [
      {
        id: 0,
        main: true,
        originX: left,
        originY: top,
        widthPoints: right - left,
        heightPoints: bottom - top,
        widthPixels: right - left,
        heightPixels: bottom - top,
        backingScale: 1,
      },
    ],
    accessibilityTrusted,
    screenCaptureAllowed: null,
  }
}

/**
 * Capture the main display to a PNG.
 *
 * @param {number} displayIndex - must be 0; other displays are not addressable.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>} the PNG and its pixel size.
 */
export async function capture(displayIndex, signal) {
  if (displayIndex !== 0) {
    throw new Error(
      `the AppleScript backend can only drive the main display, but "display: ${displayIndex}" was configured; ` +
        'use the native backend for multi-display control',
    )
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-computer-use-'))
  try {
    const file = path.join(directory, 'screen.png')
    try {
      await runFile(SCREENCAPTURE, ['-x', '-m', '-t', 'png', file], { signal, timeoutMs: 30_000 })
    } catch (error) {
      if (/could not create image from display|not authorized|operation not permitted/i.test(error.message)) {
        throw new Error(
          'the screen could not be captured because Screen Recording permission is not granted. ' +
            'Grant it in System Settings > Privacy & Security > Screen Recording to the application ' +
            'running this agent, then start a new session.',
        )
      }
      throw error
    }
    const data = await readFile(file)
    const size = readPngSize(data)
    return { data, width: size.width, height: size.height }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Post one canonical action batch through `System Events`.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @param {object[]} actions - canonical actions in global display points.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Array<{index: number, type: string, summary: string}>>} what ran.
 */
export async function act(config, actions, signal) {
  const statements = []
  const executed = []
  for (const [index, action] of actions.entries()) {
    if (!SUPPORTED.has(action.type)) {
      const failure = new Error(
        `the AppleScript backend cannot perform "${action.type}"; it supports click, keypress, type and wait. ` +
          'Install the Xcode Command Line Tools (`xcode-select --install`) to use the native backend.',
      )
      failure.executed = executed
      throw failure
    }
    const line = renderStatement(action)
    statements.push(line)
    executed.push({ index, type: action.type, summary: describe(action) })
  }
  if (statements.length > 0) {
    await osascript(`tell application "System Events"\n${statements.join('\n')}\nend tell`, signal)
  }
  return executed
}

/**
 * Render one canonical action as an AppleScript statement.
 *
 * @param {object} action - a canonical action.
 * @returns {string} the statement.
 */
function renderStatement(action) {
  switch (action.type) {
    case 'click': {
      const clause = modifierClause(action.modifiers)
      const clicks = action.count > 1 ? 2 : 1
      return Array.from({ length: clicks }, () => `click at {${Math.round(action.x)}, ${Math.round(action.y)}}${clause}`).join(
        '\n',
      )
    }
    case 'keypress': {
      const clause = modifierClause(action.modifiers)
      const code = KEY_CODES[action.key]
      if (code !== undefined) return `key code ${code}${clause}`
      if ([...action.key].length === 1) return `keystroke "${escapeAppleScript(action.key)}"${clause}`
      throw new Error(`the AppleScript backend has no key code for "${action.key}"`)
    }
    case 'type':
      return `keystroke "${escapeAppleScript(action.text)}"`
    case 'wait':
      return `delay ${(action.ms / 1000).toFixed(3)}`
    default:
      throw new Error(`the AppleScript backend cannot perform "${action.type}"`)
  }
}

/**
 * Build the `using {…}` clause for a set of modifiers.
 *
 * @param {string[]} modifiers - canonical modifier names.
 * @returns {string} the clause, or an empty string.
 */
function modifierClause(modifiers) {
  if (modifiers.length === 0) return ''
  const clauses = modifiers.map((name) => {
    const clause = MODIFIER_CLAUSES[name]
    if (clause === undefined) {
      throw new Error(`the AppleScript backend cannot hold "${name}" down`)
    }
    return clause
  })
  return ` using {${clauses.join(', ')}}`
}

/**
 * Describe one action for the execution record.
 *
 * @param {object} action - a canonical action.
 * @returns {string} a short, model-facing summary.
 */
function describe(action) {
  switch (action.type) {
    case 'click':
      return `${action.count > 1 ? 'double_click' : 'click'} at (${Math.round(action.x)}, ${Math.round(action.y)})`
    case 'keypress':
      return `keypress ${action.key}${action.modifiers.length === 0 ? '' : ` with ${action.modifiers.join('+')}`}`
    case 'type':
      return `type ${action.text.length} character(s)`
    case 'wait':
      return `wait ${action.ms}ms`
    default:
      return action.type
  }
}
