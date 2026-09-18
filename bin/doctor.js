#!/usr/bin/env node
/**
 * `dsh-computer-use-doctor` — check whether the computer tool can run here.
 *
 * A computer-use agent fails in confusing ways when a permission is missing: a
 * screenshot comes back as a picture of the wallpaper, or clicks land nowhere at
 * all. This command turns that into an explicit answer before a session starts,
 * and names the exact System Settings pane to visit.
 *
 * @module dsh-plugin-computer-use/doctor
 */

import { resolveBackend } from '../src/backends/index.js'
import { resolveConfig } from '../src/config.js'

/** Exit codes, so the command is usable from a setup script. */
const EXIT_OK = 0
const EXIT_NOT_READY = 1

/** The System Settings panes the tool depends on. */
const PRIVACY_PANE = 'System Settings > Privacy & Security'

/**
 * Print one labelled line.
 *
 * @param {string} label - the field name.
 * @param {string} value - the value.
 */
function line(label, value) {
  console.log(`  ${label.padEnd(22)}${value}`)
}

/**
 * Print a pass/fail marker with an explanation.
 *
 * @param {boolean|null} ok - the check result; null means "unknown".
 * @param {string} label - the check name.
 * @param {string} [detail] - what to do about a failure.
 */
function check(ok, label, detail) {
  const marker = ok === true ? 'OK  ' : ok === false ? 'FAIL' : '?   '
  console.log(`  [${marker}] ${label}${detail === undefined ? '' : `\n         ${detail}`}`)
}

/**
 * Read a boolean flag from the command line.
 *
 * @param {string[]} argv - the process arguments.
 * @param {string} flag - the flag to look for.
 * @returns {boolean} whether it was supplied.
 */
function hasFlag(argv, flag) {
  return argv.includes(flag)
}

/**
 * Read `--cache-dir <path>` from the command line.
 *
 * The helper cache lives under `~/Library/Caches` by default; pointing it
 * elsewhere is how you check whether a failure is the toolchain or the cache
 * location, and how a CI job keeps the build inside its own workspace.
 *
 * @param {string[]} argv - the process arguments.
 * @returns {string|null} the requested directory, or null.
 */
function readCacheDir(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--cache-dir') return argv[index + 1] ?? null
    if (argument.startsWith('--cache-dir=')) return argument.slice('--cache-dir='.length)
  }
  return null
}

/**
 * Run the diagnostics.
 *
 * @returns {Promise<number>} the process exit code.
 */
async function main() {
  console.log('\ndsh-plugin-computer-use — doctor\n')

  line('platform', `${process.platform} (${process.arch})`)
  line('node', process.version)

  if (process.platform !== 'darwin') {
    console.log('\nThis plugin currently supports macOS only.\n')
    return EXIT_NOT_READY
  }

  const argv = process.argv.slice(2)
  const cacheDir = readCacheDir(argv)
  const config = resolveConfig(cacheDir === null ? {} : { helperCacheDir: cacheDir })
  let backend
  try {
    backend = await resolveBackend(config)
  } catch (error) {
    console.log(`\n  backend resolution failed: ${error.message}\n`)
    return EXIT_NOT_READY
  }
  line('backend', backend.name)
  if (typeof backend.nativeError === 'string') {
    // Under `auto`, a compile failure degrades to AppleScript. Say so: a silent
    // downgrade is the hardest kind of computer-use bug to notice.
    line('native unavailable', backend.nativeError)
  }
  if (typeof backend.helperLocation === 'function') {
    // The helper's path is a permission identity: Accessibility is granted to the
    // binary, so printing where that binary is decides whether the user grants the
    // right file or hunts for one that is not there.
    const helper = await backend.helperLocation(config)
    line('helper cache', helper.volatile ? `${helper.directory}  (volatile)` : helper.directory)
    if (helper.volatile) {
      console.log(
        '         the system reclaims this directory, so an Accessibility grant made against\n' +
          `         ${helper.path}\n` +
          '         stops working once it does. Set `helperCacheDir` to a stable path, for\n' +
          '         example ~/Library/Caches/dsh-plugin-computer-use, and start a new session.',
      )
    }
  }

  let facts
  try {
    facts = await backend.probe(config)
  } catch (error) {
    console.log(`\n  the backend could not report display facts: ${error.message}\n`)
    return EXIT_NOT_READY
  }

  console.log('\ndisplays')
  for (const [index, display] of facts.displays.entries()) {
    const scale = display.backingScale === 1 ? '1x' : `${display.backingScale}x`
    console.log(
      `  [${display.main ? 'main' : '    '}] display ${index}  ` +
        `${display.widthPoints}x${display.heightPoints} pt  ` +
        `${display.widthPixels}x${display.heightPixels} px  ${scale}  ` +
        `origin (${display.originX}, ${display.originY})`,
    )
  }

  console.log('\npermissions')
  check(
    facts.accessibilityTrusted,
    'Accessibility — post clicks and keystrokes',
    facts.accessibilityTrusted ? undefined : `add the host application under ${PRIVACY_PANE} > Accessibility`,
  )
  check(
    facts.screenCaptureAllowed,
    'Screen Recording — capture the screen',
    facts.screenCaptureAllowed === false
      ? `add the host application under ${PRIVACY_PANE} > Screen Recording`
      : facts.screenCaptureAllowed === null
        ? 'this backend cannot preflight Screen Recording; the first capture will report it'
        : undefined,
  )

  let captured = null
  let effectiveScale = null
  try {
    const shot = await backend.capture(0, undefined)
    captured = `${shot.width}x${shot.height} px PNG`
    // The capture is authoritative about backing pixels; CGDisplayPixelsWide
    // reports the point size on a display running a scaled Retina mode.
    if (facts.displays[0].widthPoints > 0) effectiveScale = shot.width / facts.displays[0].widthPoints
  } catch (error) {
    captured = `failed: ${error.message}`
  }
  console.log('\ncapture')
  check(captured.endsWith('PNG'), `main display: ${captured}`)
  if (effectiveScale !== null) line('effective scale', `${effectiveScale}x`)

  let inputVerified = null
  if (hasFlag(argv, '--test-input') && typeof backend.pointer === 'function') {
    // A permission flag is an assertion; a moved cursor is evidence. Move by a
    // small offset, confirm the cursor followed, then put it back.
    const start = await backend.pointer(config, undefined)
    const target = { x: Math.round(start.x) + 40, y: Math.round(start.y) + 40 }
    await backend.act(config, [{ type: 'move', x: target.x, y: target.y }], undefined)
    const moved = await backend.pointer(config, undefined)
    await backend.act(config, [{ type: 'move', x: Math.round(start.x), y: Math.round(start.y) }], undefined)
    inputVerified = Math.abs(moved.x - target.x) < 2 && Math.abs(moved.y - target.y) < 2
    console.log('\ninput delivery')
    check(
      inputVerified,
      inputVerified ? 'cursor control verified' : 'posted events are being discarded',
      inputVerified
        ? undefined
        : `grant Accessibility to the host application under ${PRIVACY_PANE} > Accessibility, then start a new session`,
    )
  } else if (typeof backend.pointer !== 'function') {
    console.log('\ninput delivery')
    check(null, 'not verifiable on this backend; pass --test-input with the native backend')
  }

  const ready =
    captured.endsWith('PNG') &&
    (inputVerified !== null ? inputVerified : facts.accessibilityTrusted === true)
  console.log(
    ready
      ? '\nReady: the computer tool can see the screen and post input.\n'
      : '\nNot ready yet: grant the missing permissions above, then re-run this command.\n' +
          'macOS applies permission changes to new processes, so start a new session afterwards.\n',
  )
  return ready ? EXIT_OK : EXIT_NOT_READY
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`\ndoctor failed: ${error.stack ?? error.message}\n`)
    process.exitCode = EXIT_NOT_READY
  },
)
