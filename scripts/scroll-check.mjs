#!/usr/bin/env node
/**
 * Verify the scroll sign convention against a document whose position can be read.
 *
 * `scroll` has no cursor to read back, and a screenshot cannot say which way the
 * view moved, so this asks the Accessibility API for the visible character range
 * of a `TextEdit` window. Scrolling down must move that range forward; an
 * inverted sign moves it backwards, which is the bug this exists to catch.
 *
 * The document must already be open in `TextEdit` and long enough to scroll:
 *
 *   seq 1 300 | sed 's/^/line /' > /tmp/scroll-target.txt
 *   open -a TextEdit /tmp/scroll-target.txt
 *   node scripts/scroll-check.mjs
 *
 * @module dsh-plugin-computer-use/scroll-check
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import { probe } from '../src/backends/native.js'
import { resolveConfig } from '../src/config.js'
import { readPngSize } from '../src/png.js'
import { createComputerTool } from '../src/tool.js'

const run = promisify(execFile)

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

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail === undefined ? '' : `\n         ${detail}`}`)
  if (!ok) failures += 1
}

const osa = async (script) => (await run('osascript', ['-e', script])).stdout.trim()

/** The first visible character offset, or null when TextEdit is not readable. */
async function visibleStart() {
  const raw = await osa(
    'tell application "System Events" to tell process "TextEdit" to get value of attribute "AXVisibleCharacterRange" of text area 1 of scroll area 1 of window 1',
  ).catch(() => '')
  const start = Number(raw.split(',')[0])
  return Number.isFinite(start) ? start : null
}

// Anything that posts events needs TextEdit frontmost, and this machine has more
// than one process willing to take focus, so re-assert it and confirm before
// trusting the result.
let front = ''
for (let attempt = 0; attempt < 8; attempt += 1) {
  await osa('tell application "System Events" to set frontmost of process "TextEdit" to true').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 350))
  front = await osa('tell application "System Events" to get name of first application process whose frontmost is true')
  if (front === 'TextEdit') break
}
if (front !== 'TextEdit') {
  console.log(`\n  [SKIP] another application (${front}) holds focus; not posting scroll events\n`)
  process.exit(0)
}

const facts = await probe(config, undefined)
const display = facts.displays[0]
const shot = await tool.execute({ actions: [{ type: 'screenshot' }] }, exec)
const scale = display.widthPoints / shot.image.width
// Aim at the middle of the display, which is inside the document window here.
const at = { x: Math.round(display.widthPoints / 2 / scale), y: Math.round(display.heightPoints / 2 / scale) }

const scroll = (scrollY) => tool.execute({ actions: [{ type: 'scroll', x: at.x, y: at.y, scroll_x: 0, scroll_y: scrollY }] }, exec)

console.log('\nscroll sign check\n')
const start = await visibleStart()
if (start === null) {
  console.log('  [SKIP] no readable TextEdit document; open one first\n')
  process.exit(0)
}
console.log(`  visible range starts at character ${start}`)

// Park at the top so the downward scroll has somewhere to go.
await scroll(-20000)
await new Promise((resolve) => setTimeout(resolve, 400))
const top = await visibleStart()
console.log(`  after scrolling up hard:   character ${top}`)

const down = await scroll(600)
await new Promise((resolve) => setTimeout(resolve, 400))
const afterDown = await visibleStart()
console.log(`  after scroll_y = +600:     character ${afterDown}   (${down.executed[0].summary})`)
check(afterDown > top, 'positive scroll_y moves the view down', `${top} → ${afterDown}`)

const up = await scroll(-600)
await new Promise((resolve) => setTimeout(resolve, 400))
const afterUp = await visibleStart()
console.log(`  after scroll_y = -600:     character ${afterUp}   (${up.executed[0].summary})`)
check(afterUp < afterDown, 'negative scroll_y moves the view up', `${afterDown} → ${afterUp}`)

// Leave the document where it was found.
await scroll(-20000)

console.log(failures === 0 ? '\nscroll sign check passed.\n' : `\nscroll sign check failed (${failures}).\n`)
process.exitCode = failures === 0 ? 0 : 1
