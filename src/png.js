/**
 * Minimal PNG header reader.
 *
 * Screenshots are captured by the system `screencapture` binary rather than by
 * the native helper (see `src/native/computer_helper.m` for why). That leaves
 * JavaScript holding a file whose exact pixel dimensions it must know before it
 * can map the model's coordinates. Reading them from the PNG's own IHDR chunk is
 * exact, costs nothing, and needs no image library.
 *
 * @module dsh-plugin-computer-use/png
 */

/** The eight bytes every PNG begins with. */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Read a PNG's pixel dimensions from its IHDR chunk.
 *
 * @param {Uint8Array} bytes - the complete PNG, or at least its first 24 bytes.
 * @returns {{width: number, height: number}} the image dimensions in pixels.
 * @throws {Error} when the bytes are not a PNG with a well-formed IHDR.
 */
export function readPngSize(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('readPngSize expects a Uint8Array')
  if (bytes.length < 24) {
    throw new Error(`the capture is not a usable PNG: expected at least 24 bytes, got ${bytes.length}`)
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error('the capture is not a PNG: the file signature does not match')
    }
  }
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (chunkType !== 'IHDR') {
    throw new Error(`the capture is not a usable PNG: expected an IHDR chunk, found "${chunkType}"`)
  }
  const width = readUint32(bytes, 16)
  const height = readUint32(bytes, 20)
  if (width === 0 || height === 0) {
    throw new Error('the capture is not a usable PNG: it declares a zero-sized image')
  }
  return { width, height }
}

/**
 * Read one big-endian unsigned 32-bit integer.
 *
 * @param {Uint8Array} bytes - the buffer to read from.
 * @param {number} offset - the first byte of the integer.
 * @returns {number} the decoded value.
 */
function readUint32(bytes, offset) {
  return (
    (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>>
    0
  )
}
