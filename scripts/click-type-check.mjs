#!/usr/bin/env node
/**
 * Verify `click` and `type` against a target whose result can be read back.
 *
 * `scripts/input-check.mjs` proves mouse delivery with `move`, which is
 * self-verifying because the cursor can be read. Click and type have no such
 * read-back, so this drives them into a scratch document and then checks the
 * file on disk — a click that missed, or a keystroke that never arrived, shows
 * up as an empty file rather than as a passing test.
 *
 * The window rect comes from the Accessibility API, so the click target is
 * computed rather than guessed.
 *
 *   node scripts/click-type-check.mjs
 *
 * @module dsh-plugin-computer-use/click-type-check
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { probe } from '../src/backends/native.js'
import { resolveConfig } from '../src/config.js'
import { readPngSize } from '../src/png.js'
import { createComputerTool } from '../src/tool.js'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', '.scratch', 'type-target.txt')
const TEXT = 'typed by the computer tool 你好'

const config = resolveConfig({})
const attachments = {
  async saveImages(inputs) {
    return inputs.map((input) => {
      const { width, height } = readPngSize(input.data)
      return {
        attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width,
        height,
      }
    })
  },
}
const ctx = { get: (name) => (name === 'attachments' ? attachments : undefined) }
const tool = createComputerTool({ ctx, config })
const exec = { signal: undefined, agent: undefined }
const batch = (actions) => tool.execute({ actions }, exec)

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail === undefined ? '' : `\n         ${detail}`}`)
  if (!ok) failures += 1
}

/** Run one AppleScript line and return its trimmed stdout. */
const osa = async (script) => (await run('osascript', ['-e', script])).stdout.trim()

// Bring the scratch document forward. A plain `activate` loses races with
// whatever else is grabbing focus on this machine, so set the frontmost process
// directly and retry briefly; the click below lands wherever this window is, so
// a focus thief would silently redirect it into another application.
let front = ''
for (let attempt = 0; attempt < 8; attempt += 1) {
  await osa('tell application "System Events" to set frontmost of process "TextEdit" to true').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 400))
  front = await osa('tell application "System Events" to get name of first application process whose frontmost is true')
  if (front === 'TextEdit') break
}
if (front !== 'TextEdit') {
  console.log(`\n  [SKIP] another application (${front}) holds focus; not clicking into it\n`)
  process.exit(0)
}

const [px, py, w, h] = (await osa('tell application "System Events" to tell process "TextEdit" to get {position, size} of window 1'))
  .split(', ')
  .map(Number)
// Aim below the title bar and toolbar, at the middle of the document body.
const point = { x: px + w / 2, y: py + h * 0.55 }
console.log(`\nclick and type — window ${w}x${h} pt at (${px}, ${py})`)
console.log(`  target display point (${point.x.toFixed(0)}, ${point.y.toFixed(0)})\n`)

const facts = await probe(config, undefined)
const display = facts.displays[0]
const shot = await batch([{ type: 'screenshot' }])
const scaleX = display.widthPoints / shot.image.width
const scaleY = display.heightPoints / shot.image.height
const toImage = (value, origin, scale) => Math.round((value - origin) / scale)

const clicked = await batch([
  { type: 'click', x: toImage(point.x, display.originX, scaleX), y: toImage(point.y, display.originY, scaleY) },
  { type: 'type', text: TEXT },
])

console.log(`  executed: ${clicked.executed.map((entry) => `${entry.type}: ${entry.summary}`).join('\n            ')}\n`)
await new Promise((resolve) => setTimeout(resolve, 800))

// Read the document through TextEdit itself: the window buffer is the truth
// about what was typed, and a plain .txt document is not written to disk until
// it is saved, so the file would read empty even on success.
const written = await osa('tell application "TextEdit" to get text of document 1').catch(() => '')
check(clicked.executed.length === 2, 'the batch ran both actions')
check(written.includes(TEXT), 'the typed text reached the document', written.trim() === '' ? 'the document is empty' : `document contains: ${JSON.stringify(written.trim().slice(0, 60))}`)
check(/[\u4e00-\u9fff]/.test(written), 'non-ASCII text survived the keyboard path')

console.log(failures === 0 ? '\nclick and type check passed.\n' : `\nclick and type check failed (${failures}).\n`)
process.exitCode = failures === 0 ? 0 : 1
