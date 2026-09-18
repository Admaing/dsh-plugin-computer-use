import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * These gates encode the plugin's permission policy, so they are asserted
 * directly rather than only through a live session.
 *
 * `src/tool.js` needs the harness package to import; skip when it is absent.
 */
let gates = null
try {
  gates = await import('../src/tool.js')
} catch {
  // The pure-JS suites still run; see test/tool.test.js for the same guard.
}

const READY = { screenCaptureAllowed: true, accessibilityTrusted: true }
const NO_SCREEN = { screenCaptureAllowed: false, accessibilityTrusted: true }
const NO_AX = { screenCaptureAllowed: true, accessibilityTrusted: false }
const UNKNOWN_SCREEN = { screenCaptureAllowed: null, accessibilityTrusted: true }

describe('the permission gates', { skip: gates === null }, () => {
  it('allows a capture when Screen Recording is granted', () => {
    assert.doesNotThrow(() => gates.assertScreenCaptureAllowed(READY, 'native'))
  })

  it('refuses a capture when Screen Recording is denied, naming the pane', () => {
    assert.throws(
      () => gates.assertScreenCaptureAllowed(NO_SCREEN, 'native'),
      /Screen Recording permission is not granted.*Privacy & Security > Screen Recording/s,
    )
  })

  it('treats an unknown capture state as permission to try', () => {
    // The AppleScript backend cannot preflight Screen Recording; refusing on
    // "unknown" would make that backend unusable.
    assert.doesNotThrow(() => gates.assertScreenCaptureAllowed(UNKNOWN_SCREEN, 'applescript'))
  })

  it('allows input when Accessibility is granted', () => {
    assert.doesNotThrow(() => gates.assertInputAllowed(READY, 'native'))
  })

  it('refuses input when Accessibility is denied', () => {
    // This gate is load-bearing: without Accessibility, CGEventPost reports
    // success and the event is discarded, so an agent that skipped the check
    // would click into the void and loop.
    assert.throws(
      () => gates.assertInputAllowed(NO_AX, 'native'),
      /Accessibility permission is not granted/,
    )
  })

  it('says that screenshots keep working while input is refused', () => {
    // The two gates are deliberately independent, so the model can still look
    // at the screen on a machine that has not granted Accessibility.
    assert.throws(() => gates.assertInputAllowed(NO_AX, 'native'), /Screenshot-only batches keep working/)
  })

  it('names the backend it was resolved to', () => {
    assert.throws(() => gates.assertInputAllowed(NO_AX, 'applescript'), /backend: applescript/)
  })

  it('warns that a grant against a reclaimable helper cannot stick', () => {
    // The fallback cache directory is purged by the OS, so a grant made against a
    // helper there stops working later. Saying so is the difference between a user
    // who fixes the cache and one who re-grants a permission every few days.
    assert.throws(
      () =>
        gates.assertInputAllowed(NO_AX, 'native', {
          directory: '/var/folders/xx/T/dsh-plugin-computer-use',
          volatile: true,
        }),
      /which macOS may delete at any time[\s\S]*helperCacheDir/,
    )
  })

  it('says nothing about the helper when its directory is durable', () => {
    assert.throws(
      () =>
        gates.assertInputAllowed(NO_AX, 'native', {
          directory: '/Users/someone/Library/Caches/dsh-plugin-computer-use',
          volatile: false,
        }),
      (error) => {
        assert.doesNotMatch(error.message, /macOS may delete/)
        assert.match(error.message, /\(backend: native\)$/)
        return true
      },
    )
  })
})
