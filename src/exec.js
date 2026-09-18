/**
 * A small, dependency-free subprocess helper.
 *
 * The plugin drives two system binaries (`clang` once, then the compiled helper
 * and `screencapture`) and must never leave one running past its budget, so
 * this wraps `spawn` with a timeout, cancellation, and captured output that
 * survives a non-zero exit.
 *
 * @module dsh-plugin-computer-use/exec
 */

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import path from 'node:path'

/**
 * Run one command to completion.
 *
 * @param {string} command - the executable to run.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - run options.
 * @param {string} [options.input] - text written to the child's stdin.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {number} [options.timeoutMs] - budget before the child is killed.
 * @param {string} [options.cwd] - working directory.
 * @returns {Promise<{stdout: string, stderr: string}>} the captured output.
 * @throws {Error & {stdout?: string, stderr?: string, code?: number}} on a non-zero exit,
 *   a timeout, or a spawn failure. `stdout` is preserved because the native
 *   helper reports structured partial-execution detail there.
 */
export function runFile(command, args, options = {}) {
  const { input, signal, timeoutMs = 30_000, cwd } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, signal, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    const out = []
    const err = []
    let settled = false
    let timedOut = false

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
      : null
    if (timer !== null && typeof timer.unref === 'function') timer.unref()

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (error === null) resolve(value)
      else reject(error)
    }

    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code === 0) {
        finish(null, { stdout, stderr })
        return
      }
      const detail = stderr.trim() || stdout.trim()
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exited with code ${String(code)}`
      const error = new Error(`${path.basename(command)} ${reason}${detail === '' ? '' : `: ${detail}`}`)
      error.stdout = stdout
      error.stderr = stderr
      error.code = code ?? undefined
      finish(error)
    })

    if (child.stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(input ?? '')
    }
  })
}

/**
 * Resolve an executable against `PATH`, the way a shell would.
 *
 * @param {string} command - the executable name.
 * @returns {Promise<string|null>} its absolute path, or null when it is absent.
 */
export async function which(command) {
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === '') continue
    const candidate = path.join(directory, command)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}
