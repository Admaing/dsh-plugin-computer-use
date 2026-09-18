import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  asFiniteNumber,
  isModifierKey,
  normalizeButton,
  normalizeChord,
  normalizeDragPath,
  normalizeKey,
  normalizeModifiers,
} from '../src/keys.js'

describe('normalizeKey', () => {
  it('maps the Codex aliases onto canonical macOS names', () => {
    assert.equal(normalizeKey('ENTER'), 'return')
    assert.equal(normalizeKey('RETURN'), 'return')
    assert.equal(normalizeKey('ESC'), 'escape')
    assert.equal(normalizeKey('ESCAPE'), 'escape')
    assert.equal(normalizeKey('CMD'), 'command')
    assert.equal(normalizeKey('COMMAND'), 'command')
    assert.equal(normalizeKey('CTRL'), 'control')
    assert.equal(normalizeKey('OPTION'), 'option')
    assert.equal(normalizeKey('ALT'), 'option')
    assert.equal(normalizeKey('PAGEUP'), 'pageup')
    assert.equal(normalizeKey('ARROWLEFT'), 'left')
  })

  it('keeps forward-delete and backspace distinct', () => {
    // The reference handlers treat DELETE as forward-delete, so these must not
    // collapse onto the same key code.
    assert.equal(normalizeKey('BACKSPACE'), 'delete')
    assert.equal(normalizeKey('DELETE'), 'forwarddelete')
    assert.notEqual(normalizeKey('BACKSPACE'), normalizeKey('DELETE'))
  })

  it('lowercases single characters and function keys', () => {
    assert.equal(normalizeKey('A'), 'a')
    assert.equal(normalizeKey('1'), '1')
    assert.equal(normalizeKey('F5'), 'f5')
    assert.equal(normalizeKey('f12'), 'f12')
  })

  it('passes through names the helper already understands', () => {
    assert.equal(normalizeKey('space'), 'space')
    assert.equal(normalizeKey('return'), 'return')
  })

  it('rejects empty and non-string input', () => {
    assert.throws(() => normalizeKey(''), /non-empty string/)
    assert.throws(() => normalizeKey('   '), /non-empty string/)
    assert.throws(() => normalizeKey(7), /non-empty string/)
    assert.throws(() => normalizeKey(undefined), /non-empty string/)
  })
})

describe('isModifierKey', () => {
  it('recognises every modifier spelling', () => {
    for (const name of ['command', 'cmd', 'meta', 'super', 'shift', 'option', 'alt', 'control', 'ctrl', 'fn']) {
      assert.equal(isModifierKey(name), true, name)
    }
  })

  it('does not treat ordinary keys as modifiers', () => {
    assert.equal(isModifierKey('c'), false)
    assert.equal(isModifierKey('return'), false)
  })
})

describe('normalizeChord', () => {
  it('separates modifiers from the pressed key', () => {
    assert.deepEqual(normalizeChord(['CTRL', 'C']), { key: 'c', modifiers: ['control'] })
    assert.deepEqual(normalizeChord(['CMD', 'SHIFT', 'T']), { key: 't', modifiers: ['command', 'shift'] })
  })

  it('accepts a bare key', () => {
    assert.deepEqual(normalizeChord(['ENTER']), { key: 'return', modifiers: [] })
  })

  it('deduplicates repeated modifiers', () => {
    assert.deepEqual(normalizeChord(['CMD', 'COMMAND', 'A']), { key: 'a', modifiers: ['command'] })
  })

  it('takes the last non-modifier as the key', () => {
    assert.deepEqual(normalizeChord(['CTRL', 'A', 'B']), { key: 'b', modifiers: ['control'] })
  })

  it('rejects a chord with no pressable key', () => {
    assert.throws(() => normalizeChord(['CTRL', 'SHIFT']), /one non-modifier key/)
    assert.throws(() => normalizeChord([]), /non-empty "keys" array/)
    assert.throws(() => normalizeChord('C'), /non-empty "keys" array/)
  })
})

describe('normalizeButton', () => {
  it('defaults to the left button', () => {
    assert.equal(normalizeButton(undefined), 'left')
    assert.equal(normalizeButton(null), 'left')
    assert.equal(normalizeButton(''), 'left')
  })

  it('maps the Codex button names', () => {
    assert.equal(normalizeButton('left'), 'left')
    assert.equal(normalizeButton('RIGHT'), 'right')
    assert.equal(normalizeButton('wheel'), 'middle')
    assert.equal(normalizeButton('center'), 'middle')
  })

  it('refuses buttons the platform cannot post', () => {
    assert.throws(() => normalizeButton('back'), /unsupported mouse button/)
    assert.throws(() => normalizeButton('forward'), /unsupported mouse button/)
    assert.throws(() => normalizeButton(3), /must be a string/)
  })
})

describe('normalizeModifiers', () => {
  it('returns canonical names without duplicates', () => {
    assert.deepEqual(normalizeModifiers(['CMD', 'command', 'SHIFT']), ['command', 'shift'])
  })

  it('treats absent modifiers as none', () => {
    assert.deepEqual(normalizeModifiers(undefined), [])
    assert.deepEqual(normalizeModifiers([]), [])
  })

  it('refuses a non-modifier in a pointer action', () => {
    assert.throws(() => normalizeModifiers(['a']), /not a modifier key/)
    assert.throws(() => normalizeModifiers('cmd'), /must be an array/)
  })
})

describe('normalizeDragPath', () => {
  it('accepts [x, y] pairs', () => {
    assert.deepEqual(normalizeDragPath([[0, 0], [10, 20]]), [[0, 0], [10, 20]])
  })

  it('accepts {x, y} objects, as the Codex schema allows', () => {
    assert.deepEqual(normalizeDragPath([{ x: 0, y: 0 }, { x: 10, y: 20 }]), [[0, 0], [10, 20]])
  })

  it('requires at least two points', () => {
    assert.throws(() => normalizeDragPath([[1, 2]]), /at least two path points/)
    assert.throws(() => normalizeDragPath([]), /at least two path points/)
  })

  it('refuses a malformed entry', () => {
    assert.throws(() => normalizeDragPath([[1, 2], 'nope']), /\[x, y\] pair or an \{x, y\} object/)
    assert.throws(() => normalizeDragPath([[1, 2], [3, Number.NaN]]), /finite number/)
    assert.throws(() => normalizeDragPath('nope'), /"path" array/)
  })
})

describe('asFiniteNumber', () => {
  it('accepts finite numbers only', () => {
    assert.equal(asFiniteNumber(0, 'x'), 0)
    assert.equal(asFiniteNumber(-12.5, 'x'), -12.5)
    assert.throws(() => asFiniteNumber('3', 'x'), /"x" must be a finite number/)
    assert.throws(() => asFiniteNumber(Number.POSITIVE_INFINITY, 'x'), /"x" must be a finite number/)
    assert.throws(() => asFiniteNumber(Number.NaN, 'x'), /"x" must be a finite number/)
  })
})
