#!/usr/bin/env node
/**
 * Verify the input path and the coordinate mapping against the real cursor.
 *
 * The screenshot path is proven by `scripts/smoke.mjs`; this closes the other
 * half. It drives the *same* tool the model calls, then reads the cursor back
 * with the helper and checks it landed where the mapping said it would — so a
 * wrong scale factor shows up as a wrong coordinate rather than as a plausible
 * screenshot.
 *
 *   node scripts/input-check.mjs
 *
 * @module dsh-plugin-computer-use/input-check
 */

import { createHash } from 'node:crypto'

import { pointer, probe } from '../src/backends/native.js'
import { resolveConfig } from '../src/config.js'
import { readPngSize } from '../src/png.js'
import { createComputerTool } from '../src/tool.js'

const config = resolveConfig({})

/** A stand-in for the durable attachment store; the real one belongs to a session. */
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

/**
 * Run one batch through the real tool.
 *
 * @param {object[]} actions - the batch.
 * @returns {Promise<object>} the tool's output value.
 */
const run = (actions) => tool.execute({ actions }, exec)

let failures = 0

/**
 * Assert one expectation and report it.
 *
 * @param {boolean} ok - whether it held.
 * @param {string} label - what was checked.
 * @param {string} detail - the evidence.
 */
function check(ok, label, detail) {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail === undefined ? '' : `\n         ${detail}`}`)
  if (!ok) failures += 1
}

const facts = await probe(config, undefined)
const display = facts.displays[0]
console.log(`\ninput path check — display ${display.widthPoints}x${display.heightPoints} pt\n`)

console.log('before')
const before = await pointer(config, undefined)
check(before.accessibilityTrusted === true, 'Accessibility is granted', `cursor at (${before.x.toFixed(0)}, ${before.y.toFixed(0)})`)

// A screenshot establishes the coordinate space the model would measure in.
const shot = await run([{ type: 'screenshot' }])
console.log(`\ngeometry\n  ${shot.mapping}\n`)

const image = { width: shot.image.width, height: shot.image.height }
const scaleX = display.widthPoints / image.width
const scaleY = display.heightPoints / image.height

// Pick a point away from the corners so a wrong scale cannot pass by accident,
// and remember where the cursor was so it can be put back afterwards.
const target = { x: Math.round(image.width * 0.62), y: Math.round(image.height * 0.58) }
const expected = {
  x: display.originX + target.x * scaleX,
  y: display.originY + target.y * scaleY,
}

console.log(`move\n  image point (${target.x}, ${target.y})`)
console.log(`  expected display point (${expected.x.toFixed(1)}, ${expected.y.toFixed(1)})`)

const moved = await run([{ type: 'move', x: target.x, y: target.y }])
const after = await pointer(config, undefined)

console.log(`  actual   display point (${after.x.toFixed(1)}, ${after.y.toFixed(1)})`)
console.log(`  tool reported: ${moved.executed.map((entry) => entry.summary).join(', ')}\n`)

const dx = Math.abs(after.x - expected.x)
const dy = Math.abs(after.y - expected.y)
check(dx <= 2 && dy <= 2, 'the cursor landed where the mapping predicted', `off by (${dx.toFixed(1)}, ${dy.toFixed(1)}) pt`)
check(after.x !== before.x || after.y !== before.y, 'the cursor actually moved', 'input events were delivered, not discarded')
check(moved.image !== undefined, 'a fresh screenshot came back with the batch', `${moved.image.width}x${moved.image.height}`)

// Put the cursor back so the check leaves no trace on the user's desktop.
await run([{ type: 'move', x: Math.round((before.x - display.originX) / scaleX), y: Math.round((before.y - display.originY) / scaleY) }])
const restored = await pointer(config, undefined)
check(
  Math.abs(restored.x - before.x) <= 2 && Math.abs(restored.y - before.y) <= 2,
  'the cursor was restored to where it started',
  `(${restored.x.toFixed(0)}, ${restored.y.toFixed(0)})`,
)

console.log(failures === 0 ? '\ninput path check passed.\n' : `\ninput path check failed (${failures}).\n`)
process.exitCode = failures === 0 ? 0 : 1
