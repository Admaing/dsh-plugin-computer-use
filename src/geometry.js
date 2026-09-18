/**
 * Coordinate mapping between the screenshot the model saw and the display.
 *
 * Three spaces are in play, and conflating them is the classic computer-use bug:
 *
 * - **image space** — pixels of the PNG the model actually received. The
 *   attachment service may downscale a large capture, so this is *not*
 *   necessarily the capture's own size.
 * - **pixel space** — pixels of the capture on disk, i.e. the display's backing
 *   resolution.
 * - **point space** — the global, top-left-origin coordinate space `CGEvent`
 *   posts into. A Retina display has twice as many pixels as points.
 *
 * The model measures in image space. The native helper posts in point space.
 * Everything between them lives here.
 *
 * @module dsh-plugin-computer-use/geometry
 */

/**
 * @typedef {object} DisplayFacts
 * @property {number} originX - display origin in global points.
 * @property {number} originY - display origin in global points.
 * @property {number} widthPoints - display width in points.
 * @property {number} heightPoints - display height in points.
 * @property {number} widthPixels - display width in backing pixels.
 * @property {number} heightPixels - display height in backing pixels.
 * @property {number} backingScale - backing pixels per point.
 */

/**
 * @typedef {object} ImageFacts
 * @property {number} width - width of the image the model received.
 * @property {number} height - height of the image the model received.
 */

/**
 * Points per image pixel, per axis.
 *
 * The two axes are computed independently: a downscale is aspect-preserving in
 * practice, but deriving each axis from its own measurement means a rounding
 * difference can never accumulate into a systematic offset on one axis.
 *
 * @param {DisplayFacts} display - the display the screenshot came from.
 * @param {ImageFacts} image - the image the model received.
 * @returns {{x: number, y: number}} points per image pixel on each axis.
 */
export function pointsPerImagePixel(display, image) {
  if (!(image.width > 0) || !(image.height > 0)) {
    throw new Error('the screenshot has no usable dimensions')
  }
  return {
    x: display.widthPoints / image.width,
    y: display.heightPoints / image.height,
  }
}

/**
 * Map one image-space coordinate onto global display points.
 *
 * @param {DisplayFacts} display - the display the screenshot came from.
 * @param {ImageFacts} image - the image the model received.
 * @param {number} x - x in image pixels.
 * @param {number} y - y in image pixels.
 * @returns {{x: number, y: number}} the coordinate in global display points.
 */
export function imageToDisplayPoint(display, image, x, y) {
  const scale = pointsPerImagePixel(display, image)
  return {
    x: display.originX + x * scale.x,
    y: display.originY + y * scale.y,
  }
}

/**
 * Describe the mapping in the words the model needs to trust its coordinates.
 *
 * The model should never have to scale anything itself; this text exists so it
 * can tell that a coordinate it measured on the screenshot is being used as-is,
 * and can notice when a screenshot was downscaled.
 *
 * @param {DisplayFacts} display - the display the screenshot came from.
 * @param {ImageFacts} image - the image the model received.
 * @returns {string} a one-line, model-facing description of the mapping.
 */
export function describeMapping(display, image) {
  const scale = pointsPerImagePixel(display, image)
  const parts = [`screenshot ${image.width}x${image.height} px`]
  if (image.width !== display.widthPixels || image.height !== display.heightPixels) {
    parts.push(`downscaled from a ${display.widthPixels}x${display.heightPixels} px capture`)
  }
  parts.push(`display ${formatNumber(display.widthPoints)}x${formatNumber(display.heightPoints)} pt`)
  if (display.backingScale !== 1) parts.push(`backing scale ${formatNumber(display.backingScale)}x`)
  parts.push(`1 screenshot px = ${formatNumber(scale.x)}x${formatNumber(scale.y)} display pt`)
  return parts.join(' · ')
}

/**
 * Render a number without a trailing `.0`.
 *
 * @param {number} value - the number to render.
 * @returns {string} the shortest faithful representation.
 */
function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}
