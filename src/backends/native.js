/**
 * The native macOS backend: a small Objective-C helper plus `screencapture`.
 *
 * The helper is compiled on first use and cached by source digest, so a fresh
 * install costs one `clang` invocation (~0.5 s) and every later start is free.
 * Compilation rather than a prebuilt binary keeps the package portable across
 * architectures and free of an unsigned-blob download.
 *
 * Screenshots go through the system `screencapture` binary instead of the
 * helper because `CGDisplayCreateImage` is obsoleted from macOS 15 onward; see
 * `src/native/computer_helper.m`.
 *
 * @module dsh-plugin-computer-use/backends/native
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runFile, which } from '../exec.js'
import { readPngSize } from '../png.js'

/** The helper's Objective-C source, resolved relative to this module. */
const SOURCE_PATH = fileURLToPath(new URL('../native/computer_helper.m', import.meta.url))

/** The system capture utility. */
const SCREENCAPTURE = '/usr/sbin/screencapture'

/** One compile promise per configured cache location, so concurrent calls compile once. */
const helperCache = new Map()

/**
 * Resolve the compiled helper, compiling it when the cache is cold or stale.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @returns {Promise<string>} the absolute path of a runnable helper.
 * @throws {Error} when the toolchain or the source is missing, or compilation fails.
 */
export function ensureHelper(config) {
  const key = config.helperCacheDir ?? ''
  let pending = helperCache.get(key)
  if (pending === undefined) {
    pending = resolveCacheDirectory(config).then((directory) => compileHelper(directory))
    helperCache.set(key, pending)
    // A failed compile must not poison the cache for a later retry.
    pending.catch(() => helperCache.delete(key))
  }
  return pending
}

/**
 * Choose a writable directory to hold the compiled helper.
 *
 * The user cache is preferred so a grant survives reboots, but a locked-down or
 * read-only home directory must not cost the user the native backend: falling
 * back to the system temporary directory keeps full input control available,
 * at the price of recompiling after the OS reclaims it. An explicitly
 * configured directory is honoured exactly, so a misconfiguration is reported
 * rather than quietly worked around.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @returns {Promise<string>} a directory that exists and is writable.
 */
async function resolveCacheDirectory(config) {
  if (config.helperCacheDir !== null) {
    await mkdir(config.helperCacheDir, { recursive: true })
    return config.helperCacheDir
  }
  const preferred = path.join(homedir(), 'Library', 'Caches', 'dsh-plugin-computer-use')
  try {
    await mkdir(preferred, { recursive: true })
    return preferred
  } catch {
    const fallback = path.join(tmpdir(), 'dsh-plugin-computer-use')
    await mkdir(fallback, { recursive: true })
    return fallback
  }
}

/**
 * Compile the helper into `directory`, reusing a binary whose digest matches.
 *
 * @param {string} directory - the cache directory.
 * @returns {Promise<string>} the helper's absolute path.
 */
async function compileHelper(directory) {
  const compiler = await which('clang')
  if (compiler === null) {
    throw new Error(
      'the native backend needs the Xcode Command Line Tools: "clang" was not found on PATH. ' +
        'Install them with `xcode-select --install`, or select the AppleScript backend with ' +
        '`backend: applescript` in the plugin configuration.',
    )
  }
  let source
  try {
    source = await readFile(SOURCE_PATH)
  } catch (error) {
    throw new Error(`the native helper source is missing at ${SOURCE_PATH}: ${error.message}`)
  }
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
  await mkdir(directory, { recursive: true })
  const binary = path.join(directory, `computer-helper-${digest}`)
  try {
    await access(binary, constants.X_OK)
    return binary
  } catch {
    // Cold cache, or the previous compile was interrupted.
  }

  const staging = `${binary}.${process.pid}.tmp`
  try {
    await runFile(
      compiler,
      [
        '-O2',
        '-fobjc-arc',
        '-o',
        staging,
        SOURCE_PATH,
        '-framework',
        'Foundation',
        '-framework',
        'CoreGraphics',
        '-framework',
        'ApplicationServices',
      ],
      { timeoutMs: 180_000 },
    )
    // Rename last: a half-written binary never becomes visible under its final name.
    await rename(staging, binary)
  } catch (error) {
    await rm(staging, { force: true })
    throw new Error(`the native helper could not be compiled: ${error.message}`)
  }
  return binary
}

/**
 * Read display geometry and TCC permission state from the helper.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{displays: object[], accessibilityTrusted: boolean, screenCaptureAllowed: boolean}>} probe facts.
 */
export async function probe(config, signal) {
  const helper = await ensureHelper(config)
  const { stdout } = await runFile(helper, ['probe'], { signal, timeoutMs: 15_000 })
  let facts
  try {
    facts = JSON.parse(stdout)
  } catch {
    throw new Error(`the native helper returned unreadable output: ${stdout.trim().slice(0, 200)}`)
  }
  if (facts?.ok !== true || !Array.isArray(facts.displays)) {
    throw new Error(`the native helper could not report display facts: ${String(facts?.error ?? 'unknown error')}`)
  }
  return {
    displays: facts.displays,
    accessibilityTrusted: facts.accessibilityTrusted === true,
    screenCaptureAllowed: facts.screenCaptureAllowed === true,
  }
}

/**
 * Read the current cursor position.
 *
 * This is the only honest way to tell whether posted mouse events are being
 * delivered: without Accessibility permission `CGEventPost` returns success and
 * the event is discarded, so a caller that only checks for errors believes it
 * moved the cursor when nothing happened.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{x: number, y: number, accessibilityTrusted: boolean}>} the cursor position in global display points.
 */
export async function pointer(config, signal) {
  const helper = await ensureHelper(config)
  const { stdout } = await runFile(helper, ['pointer'], { signal, timeoutMs: 15_000 })
  let facts
  try {
    facts = JSON.parse(stdout)
  } catch {
    throw new Error(`the native helper returned unreadable output: ${stdout.trim().slice(0, 200)}`)
  }
  if (facts?.ok !== true) {
    throw new Error(`the native helper could not read the cursor: ${String(facts?.error ?? 'unknown error')}`)
  }
  return { x: facts.x, y: facts.y, accessibilityTrusted: facts.accessibilityTrusted === true }
}

/**
 * Post one canonical action batch.
 *
 * @param {import('../config.js').ComputerUseConfig} config - the resolved configuration.
 * @param {object[]} actions - canonical actions in global display points.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Array<{index: number, type: string, summary: string}>>} what actually ran.
 * @throws {Error & {executed?: object[]}} naming the failing action and what preceded it.
 */
export async function act(config, actions, signal) {
  const helper = await ensureHelper(config)
  try {
    const { stdout } = await runFile(helper, ['act'], {
      input: JSON.stringify({ actions }),
      signal,
      timeoutMs: 120_000,
    })
    const result = JSON.parse(stdout)
    return Array.isArray(result.executed) ? result.executed : []
  } catch (error) {
    // The helper reports partial execution on stdout even when it exits non-zero,
    // because the model must learn exactly how far the batch got.
    const parsed = parseHelperFailure(error.stdout)
    const failure = new Error(parsed?.error ?? error.message)
    failure.executed = parsed?.executed ?? []
    throw failure
  }
}

/**
 * Parse the helper's structured failure envelope.
 *
 * @param {string|undefined} stdout - the helper's captured stdout.
 * @returns {{error?: string, executed?: object[]}|null} the envelope, or null.
 */
function parseHelperFailure(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null
  try {
    const parsed = JSON.parse(stdout)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Capture one display to a PNG.
 *
 * @param {number} displayIndex - 0-based display index, main display first.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>} the PNG and its pixel size.
 * @throws {Error} with permission guidance when Screen Recording is unavailable.
 */
export async function capture(displayIndex, signal) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-computer-use-'))
  try {
    const file = path.join(directory, 'screen.png')
    // `-D` is 1-based with the main display at 1, which is the same order the
    // helper reports displays in.
    await runFile(SCREENCAPTURE, ['-x', '-D', String(displayIndex + 1), '-t', 'png', file], {
      signal,
      timeoutMs: 30_000,
    })
    const data = await readFile(file)
    const size = readPngSize(data)
    return { data, width: size.width, height: size.height }
  } catch (error) {
    if (/could not create image from display|not authorized|operation not permitted/i.test(error.message)) {
      throw new Error(
        'the screen could not be captured because Screen Recording permission is not granted. ' +
          'Grant it in System Settings > Privacy & Security > Screen Recording to the application ' +
          'running this agent (and, if listed, to the "computer-helper" binary in ' +
          '~/Library/Caches/dsh-plugin-computer-use), then start a new session.',
      )
    }
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
