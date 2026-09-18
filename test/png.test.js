import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readPngSize } from '../src/png.js'

/**
 * Build a minimal PNG header: signature, IHDR length, IHDR type, dimensions.
 *
 * @param {number} width - declared width.
 * @param {number} height - declared height.
 * @param {object} [options] - overrides for the malformed cases.
 * @returns {Uint8Array} the bytes.
 */
function pngHeader(width, height, options = {}) {
  const bytes = new Uint8Array(24)
  bytes.set(options.signature ?? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const chunkType = options.chunkType ?? 'IHDR'
  for (let index = 0; index < 4; index += 1) bytes[12 + index] = chunkType.charCodeAt(index)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

describe('readPngSize', () => {
  it('reads the IHDR dimensions', () => {
    assert.deepEqual(readPngSize(pngHeader(1470, 956)), { width: 1470, height: 956 })
  })

  it('reads dimensions above 2^24 without sign confusion', () => {
    assert.deepEqual(readPngSize(pngHeader(3840, 2160)), { width: 3840, height: 2160 })
  })

  it('reads a real PNG produced by the system', async () => {
    // A 1x1 PNG, base64-decoded, exercises the same path a screenshot takes.
    const onePixel =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bytes = new Uint8Array(Buffer.from(onePixel, 'base64'))
    assert.deepEqual(readPngSize(bytes), { width: 1, height: 1 })
  })

  it('rejects a non-PNG signature', () => {
    assert.throws(() => readPngSize(pngHeader(1, 1, { signature: [0, 1, 2, 3, 4, 5, 6, 7] })), /signature does not match/)
  })

  it('rejects a PNG whose first chunk is not IHDR', () => {
    assert.throws(() => readPngSize(pngHeader(1, 1, { chunkType: 'IDAT' })), /expected an IHDR chunk, found "IDAT"/)
  })

  it('rejects a truncated header', () => {
    assert.throws(() => readPngSize(new Uint8Array(8)), /expected at least 24 bytes/)
  })

  it('rejects a zero-sized image', () => {
    assert.throws(() => readPngSize(pngHeader(0, 10)), /zero-sized image/)
    assert.throws(() => readPngSize(pngHeader(10, 0)), /zero-sized image/)
  })

  it('rejects non-byte input', () => {
    assert.throws(() => readPngSize('not bytes'), /expects a Uint8Array/)
    assert.throws(() => readPngSize(null), /expects a Uint8Array/)
  })
})
