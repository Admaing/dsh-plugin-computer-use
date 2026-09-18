#!/usr/bin/env node
/**
 * End-to-end smoke test: drive the real `computer` tool against this machine.
 *
 * This is not a unit test. It builds the actual tool, runs a real action batch
 * through the real backend, captures a real screenshot, and writes it to disk so
 * a human can confirm that what the model would have seen is the actual screen.
 *
 * The attachment store is stubbed, because the durable store belongs to a live
 * DSH session; everything else is the production path.
 *
 *   node scripts/smoke.mjs [output.png]
 *
 * @module dsh-plugin-computer-use/smoke
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readPngSize } from '../src/png.js'
import { resolveConfig } from '../src/config.js'
import { createComputerTool } from '../src/tool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const outputPath = process.argv[2] ?? path.join(root, '.scratch', 'smoke-screen.png')
const cacheDir = path.join(root, '.scratch', 'helper-cache')

/**
 * A stand-in for the harness attachment store.
 *
 * It performs the one part of that contract this script depends on — returning a
 * reference whose `width`/`height` describe the image the model would receive —
 * and writes the bytes out so a human can look at them.
 *
 * @param {string} target - where to write the last committed image.
 * @returns {object} an object with the `saveImages` method the tool calls.
 */
function stubAttachments(target) {
  return {
    async saveImages(inputs) {
      const references = []
      for (const input of inputs) {
        const { width, height } = readPngSize(input.data)
        references.push({
          attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width,
          height,
        })
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, input.data)
      }
      return references
    },
  }
}

/**
 * Run the smoke test.
 */
async function main() {
  const config = resolveConfig({ helperCacheDir: cacheDir })
  const attachments = stubAttachments(outputPath)
  const ctx = { get: (name) => (name === 'attachments' ? attachments : undefined) }
  const tool = createComputerTool({ ctx, config })

  console.log('running one screenshot batch through the real tool…')
  const value = await tool.execute({ actions: [{ type: 'screenshot' }] }, { signal: undefined, agent: undefined })

  const [text] = tool.output.render({}, value)
  console.log(`\n${text.text}\n`)
  console.log(`backend       ${value.backend}`)
  console.log(`display       ${value.displayIndex}`)
  console.log(`screenshot    ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`)
  console.log(`written to    ${outputPath}`)

  const blocks = tool.output.render({}, value)
  const imageBlocks = blocks.filter((block) => block.type === 'image')
  if (imageBlocks.length !== 1) throw new Error(`expected exactly one image block, got ${imageBlocks.length}`)
  if (imageBlocks[0].attachment.attachmentId !== value.image.attachmentId) {
    throw new Error('the rendered image block does not reference the committed screenshot')
  }
  console.log('\nsmoke test passed: the tool returned one screenshot as an image block.')
}

main().catch((error) => {
  console.error(`\nsmoke test failed: ${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
