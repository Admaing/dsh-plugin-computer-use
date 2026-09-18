import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_CONFIG } from '../src/config.js'
import { applescriptBackend, nativeBackend, resolveBackend } from '../src/backends/index.js'
import { act, ensureHelper, probe } from '../src/backends/native.js'

const onMac = process.platform === 'darwin'
const skip = onMac ? false : 'the native backend is macOS only'

/**
 * A configuration that compiles into a throwaway directory.
 *
 * @returns {object} the resolved configuration.
 */
function testConfig() {
  return { ...DEFAULT_CONFIG, helperCacheDir: new URL('../.scratch/helper-cache/', import.meta.url).pathname }
}

describe('the native backend', { skip }, () => {
  it('compiles the helper from source and reuses the binary', async () => {
    const first = await ensureHelper(testConfig())
    const second = await ensureHelper(testConfig())
    assert.equal(first, second, 'the compiled helper should be cached by source digest')
    assert.match(first, /computer-helper-[0-9a-f]{16}$/)
  })

  it('reports displays with the geometry the coordinate mapper needs', async () => {
    const facts = await probe(testConfig())
    assert.ok(facts.displays.length >= 1, 'at least one display must be active')
    const main = facts.displays[0]
    for (const field of ['originX', 'originY', 'widthPoints', 'heightPoints', 'widthPixels', 'heightPixels', 'backingScale']) {
      assert.equal(typeof main[field], 'number', `display.${field} must be a number`)
    }
    assert.ok(main.widthPoints > 0 && main.heightPoints > 0)
    assert.ok(main.widthPixels >= main.widthPoints, 'backing pixels cannot be fewer than points')
    assert.equal(typeof facts.accessibilityTrusted, 'boolean')
    assert.equal(typeof facts.screenCaptureAllowed, 'boolean')
  })

  it('executes a batch and reports each action', async () => {
    // `wait` is the one action that posts no input events, so it is safe to run
    // anywhere — including on a machine with no permissions granted yet.
    const executed = await act(testConfig(), [
      { type: 'wait', ms: 1 },
      { type: 'wait', ms: 1 },
    ])
    assert.equal(executed.length, 2)
    assert.deepEqual(executed.map((entry) => entry.index), [0, 1])
    assert.match(executed[0].summary, /wait 1ms/)
  })

  it('reports what already ran when a later action fails', async () => {
    await assert.rejects(
      act(testConfig(), [{ type: 'wait', ms: 1 }, { type: 'keypress', key: 'not-a-key' }]),
      (error) => {
        assert.match(error.message, /unknown key "not-a-key"/)
        assert.equal(error.executed.length, 1)
        assert.match(error.executed[0].summary, /wait 1ms/)
        return true
      },
    )
  })

  it('rejects an unsupported action rather than ignoring it', async () => {
    await assert.rejects(act(testConfig(), [{ type: 'teleport' }]), /unsupported action "teleport"/)
  })
})

describe('backend resolution', { skip }, () => {
  it('honours an explicit native choice', async () => {
    const backend = await resolveBackend({ ...DEFAULT_CONFIG, backend: 'native', helperCacheDir: testConfig().helperCacheDir })
    assert.equal(backend.name, 'native')
  })

  it('honours an explicit AppleScript choice without compiling anything', async () => {
    const backend = await resolveBackend({ ...DEFAULT_CONFIG, backend: 'applescript' })
    assert.equal(backend.name, 'applescript')
  })

  it('prefers the native backend under "auto"', async () => {
    const backend = await resolveBackend({ ...DEFAULT_CONFIG, helperCacheDir: testConfig().helperCacheDir })
    assert.equal(backend.name, 'native')
  })

  it('exposes the same surface on both backends', () => {
    for (const backend of [nativeBackend, applescriptBackend]) {
      for (const method of ['probe', 'capture', 'act']) {
        assert.equal(typeof backend[method], 'function', `${backend.name}.${method}`)
      }
    }
  })
})
