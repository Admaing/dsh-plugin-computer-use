import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeMapping, imageToDisplayPoint, pointsPerImagePixel } from '../src/geometry.js'

/** A 1470x956-point display captured 1:1, like the machine this was built on. */
const PLAIN = {
  originX: 0,
  originY: 0,
  widthPoints: 1470,
  heightPoints: 956,
  widthPixels: 1470,
  heightPixels: 956,
  backingScale: 1,
}

/** A Retina display: 1440x900 points, 2880x1800 backing pixels. */
const RETINA = {
  originX: 0,
  originY: 0,
  widthPoints: 1440,
  heightPoints: 900,
  widthPixels: 2880,
  heightPixels: 1800,
  backingScale: 2,
}

/** A secondary display placed to the right of the main one, with a negative y. */
const OFFSET = {
  originX: 1470,
  originY: -124,
  widthPoints: 1920,
  heightPoints: 1080,
  widthPixels: 1920,
  heightPixels: 1080,
  backingScale: 1,
}

describe('pointsPerImagePixel', () => {
  it('is 1:1 when the capture matches the display points', () => {
    assert.deepEqual(pointsPerImagePixel(PLAIN, { width: 1470, height: 956 }), { x: 1, y: 1 })
  })

  it('accounts for the Retina backing factor', () => {
    // A full-resolution Retina capture is 2 pixels per point, so one image pixel
    // is half a point.
    assert.deepEqual(pointsPerImagePixel(RETINA, { width: 2880, height: 1800 }), { x: 0.5, y: 0.5 })
  })

  it('accounts for an attachment downscale', () => {
    // The model saw a 1440x900 image that was captured at 2880x1800 backing
    // pixels on a 1440x900-point display: one image pixel is one point.
    assert.deepEqual(pointsPerImagePixel(RETINA, { width: 1440, height: 900 }), { x: 1, y: 1 })
  })

  it('computes each axis independently', () => {
    const scale = pointsPerImagePixel(PLAIN, { width: 735, height: 956 })
    assert.deepEqual(scale, { x: 2, y: 1 })
  })

  it('refuses a degenerate image', () => {
    assert.throws(() => pointsPerImagePixel(PLAIN, { width: 0, height: 10 }), /no usable dimensions/)
    assert.throws(() => pointsPerImagePixel(PLAIN, { width: 10, height: 0 }), /no usable dimensions/)
  })
})

describe('imageToDisplayPoint', () => {
  it('passes coordinates through on a 1:1 display', () => {
    assert.deepEqual(imageToDisplayPoint(PLAIN, { width: 1470, height: 956 }, 405, 157), { x: 405, y: 157 })
  })

  it('halves coordinates measured on a full-resolution Retina capture', () => {
    assert.deepEqual(imageToDisplayPoint(RETINA, { width: 2880, height: 1800 }, 810, 314), { x: 405, y: 157 })
  })

  it('applies the display origin for a secondary display', () => {
    assert.deepEqual(imageToDisplayPoint(OFFSET, { width: 1920, height: 1080 }, 100, 200), { x: 1570, y: 76 })
  })

  it('maps a downscaled screenshot back onto the original coordinates', () => {
    // Captured 2880x1800, delivered as 1440x900. The model's (720, 450) is the
    // centre of the image, which is the centre of the 1440x900-point display.
    assert.deepEqual(imageToDisplayPoint(RETINA, { width: 1440, height: 900 }, 720, 450), { x: 720, y: 450 })
  })

  it('handles the origin corner exactly', () => {
    assert.deepEqual(imageToDisplayPoint(OFFSET, { width: 1920, height: 1080 }, 0, 0), { x: 1470, y: -124 })
  })
})

describe('describeMapping', () => {
  it('states the ratio the model can check its coordinates against', () => {
    const text = describeMapping(PLAIN, { width: 1470, height: 956 })
    assert.match(text, /screenshot 1470x956 px/)
    assert.match(text, /display 1470x956 pt/)
    assert.match(text, /1 screenshot px = 1x1 display pt/)
  })

  it('mentions a downscale when the attachment service shrank the image', () => {
    const text = describeMapping(RETINA, { width: 1440, height: 900 })
    assert.match(text, /downscaled from a 2880x1800 px capture/)
    assert.match(text, /backing scale 2x/)
  })

  it('omits the backing scale when it is 1', () => {
    assert.doesNotMatch(describeMapping(PLAIN, { width: 1470, height: 956 }), /backing scale/)
  })

  it('renders fractional ratios without trailing zeroes', () => {
    const text = describeMapping(RETINA, { width: 2880, height: 1800 })
    assert.match(text, /1 screenshot px = 0\.5x0\.5 display pt/)
  })
})
