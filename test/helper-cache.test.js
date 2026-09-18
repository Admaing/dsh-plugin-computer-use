import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { isVolatileHelperCache } from '../src/backends/native.js'

/** The directory `resolveCacheDirectory` falls back to when the user cache is not writable. */
const RECLAIMABLE = path.join(tmpdir(), 'dsh-plugin-computer-use')

/** The directory it prefers when the user cache is writable. */
const DURABLE = path.join(homedir(), 'Library', 'Caches', 'dsh-plugin-computer-use')

describe('the helper cache location', () => {
  it('treats the fallback directory and its contents as reclaimable', () => {
    // A grant is bound to the helper's path, and the system purges this directory,
    // so a grant made here does not survive — the caller must be able to say so.
    assert.equal(isVolatileHelperCache(RECLAIMABLE), true)
    assert.equal(isVolatileHelperCache(path.join(RECLAIMABLE, 'computer-helper-0123456789abcdef')), true)
  })

  it('treats the preferred user cache as durable', () => {
    assert.equal(isVolatileHelperCache(DURABLE), false)
    assert.equal(isVolatileHelperCache(path.join(DURABLE, 'computer-helper-0123456789abcdef')), false)
  })

  it('does not treat a sibling directory sharing the prefix as reclaimable', () => {
    // A bare string prefix test would call this volatile, and then send the user
    // chasing a permission that was never the problem.
    assert.equal(isVolatileHelperCache(`${RECLAIMABLE}-somewhere-else`), false)
    assert.equal(isVolatileHelperCache(`${RECLAIMABLE}-somewhere-else/computer-helper-0123456789abcdef`), false)
  })
})
