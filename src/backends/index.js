/**
 * Backend selection.
 *
 * A backend owns everything platform-specific: how display geometry and
 * permissions are discovered, how a screenshot becomes PNG bytes, and how a
 * canonical action batch becomes real input events. The tool itself never
 * branches on the platform.
 *
 * @module dsh-plugin-computer-use/backends
 */

import * as applescript from './applescript.js'
import * as native from './native.js'

/**
 * @typedef {object} Backend
 * @property {string} name - `native` or `applescript`.
 * @property {(config: object, signal?: AbortSignal) => Promise<object>} probe - display and permission facts.
 * @property {(displayIndex: number, signal?: AbortSignal) => Promise<{data: Uint8Array, width: number, height: number}>} capture - one PNG.
 * @property {(config: object, actions: object[], signal?: AbortSignal) => Promise<object[]>} act - post a batch.
 * @property {(config: object) => Promise<{path: string, directory: string, volatile: boolean}>} [helperLocation] - where a compiled helper lives and whether a grant there survives; absent when the backend compiles nothing.
 */

/** The native helper backend: precise input, multi-display, needs a toolchain. */
export const nativeBackend = Object.freeze({ name: 'native', ...native })

/** The AppleScript backend: no toolchain, reduced action set, main display only. */
export const applescriptBackend = Object.freeze({ name: 'applescript', ...applescript })

/**
 * Choose the backend a configuration asks for.
 *
 * `auto` prefers the native backend and silently degrades to AppleScript when
 * the toolchain is missing, because a working reduced backend beats a hard
 * failure. An explicit choice is honoured exactly: if `native` was requested and
 * cannot be built, that is an error, not a quiet downgrade.
 *
 * When `auto` does degrade, the reason rides along on the returned backend as
 * `nativeError`, so diagnostics can explain a reduction the user never asked for.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @returns {Promise<Backend>} the backend to use.
 * @throws {Error} on an unsupported platform, or an explicit backend that cannot run.
 */
export async function resolveBackend(config) {
  if (process.platform !== 'darwin') {
    throw new Error(
      `the computer-use plugin currently supports macOS only; this host is "${process.platform}"`,
    )
  }
  if (config.backend === 'applescript') return applescriptBackend
  if (config.backend === 'native') {
    await native.ensureHelper(config)
    return nativeBackend
  }
  try {
    await native.ensureHelper(config)
    return nativeBackend
  } catch (error) {
    return { ...applescriptBackend, nativeError: error.message }
  }
}
