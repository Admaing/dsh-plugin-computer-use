import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_CONFIG } from '../src/config.js'

/**
 * `src/tool.js` imports `defineTool` from the harness package, exactly as every
 * shipped DSH tool plugin does. That package is a peer dependency: it is always
 * present inside a DSH deployment, but a bare clone only has it after
 * `npm install`. Skip these tests rather than fail the suite when it is absent,
 * so the pure-JS suites always run.
 */
let createComputerTool
let toolDescription
let unavailable = null
try {
  const module = await import('../src/tool.js')
  createComputerTool = module.createComputerTool
  toolDescription = module.COMPUTER_TOOL_DESCRIPTION
} catch (error) {
  unavailable = error.message
  console.error(
    `\n  skipping the tool schema suite: ${error.message}\n` +
      '  run `npm install` to fetch the @deepseek-ai/dsh-tools devDependency.\n',
  )
}

/**
 * Build the tool with a context that resolves no optional services.
 *
 * @returns {object} the tool definition.
 */
function buildTool() {
  return createComputerTool({
    ctx: { get: () => undefined },
    config: DEFAULT_CONFIG,
  })
}

describe('the computer tool definition', { skip: unavailable !== null }, () => {
  it('is named after the Codex tool', () => {
    assert.equal(buildTool().name, 'computer')
  })

  it('describes the untrusted-screen rule to the model', () => {
    assert.match(toolDescription, /untrusted data/)
    assert.match(toolDescription, /never permission/)
  })

  it('tells the model not to pre-scale coordinates', () => {
    assert.match(toolDescription, /never pre-scale/)
  })

  it('offers every action as a discriminated union branch', () => {
    const schema = buildTool().parameters
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['actions'])
    const items = schema.properties.actions.items
    const types = items.oneOf.flatMap((branch) => branch.properties.type.enum)
    assert.deepEqual(
      [...types].sort(),
      ['click', 'double_click', 'drag', 'keypress', 'move', 'screenshot', 'scroll', 'type', 'wait'],
    )
  })

  it('makes each branch closed and marks its required fields', () => {
    const items = buildTool().parameters.properties.actions.items
    for (const branch of items.oneOf) {
      assert.equal(branch.type, 'object', branch.properties.type.enum[0])
      assert.equal(branch.additionalProperties, false, branch.properties.type.enum[0])
    }
    const click = items.oneOf.find((branch) => branch.properties.type.enum[0] === 'click')
    assert.deepEqual([...click.required].sort(), ['x', 'y'])
    const keypress = items.oneOf.find((branch) => branch.properties.type.enum[0] === 'keypress')
    assert.deepEqual(keypress.required, ['keys'])
  })

  it('is not concurrency safe, because input events are global', () => {
    assert.equal(buildTool().isConcurrencySafe(), false)
  })

  it('allows a batch long enough to include a wait', () => {
    assert.ok(buildTool().timeoutMs >= 120_000)
  })
})

describe('the computer tool result', { skip: unavailable !== null }, () => {
  /**
   * Render a result value.
   *
   * @param {object} value - the output value.
   * @returns {object[]} the content blocks.
   */
  const render = (value) => buildTool().output.render({}, value)

  const IMAGE = {
    attachmentId: 'sha256:abc',
    mediaType: 'image/png',
    bytes: 1024,
    width: 1470,
    height: 956,
  }

  it('returns the screenshot as an image block beside its envelope', () => {
    const blocks = render({
      backend: 'native',
      displayIndex: 0,
      mapping: 'screenshot 1470x956 px',
      executed: [{ index: 0, type: 'click', summary: 'click left at (405, 157)' }],
      image: IMAGE,
    })
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[1].type, 'image')
    assert.deepEqual(blocks[1].attachment, IMAGE)
  })

  it('lists every executed action in order', () => {
    const [text] = render({
      backend: 'native',
      displayIndex: 0,
      mapping: 'screenshot 1470x956 px',
      executed: [
        { index: 0, type: 'move', summary: 'move to (100, 100)' },
        { index: 1, type: 'double_click', summary: 'double_click left at (405, 157)' },
      ],
      image: IMAGE,
    })
    assert.match(text.text, /0\. move: move to \(100, 100\)/)
    assert.match(text.text, /1\. double_click: double_click left at \(405, 157\)/)
  })

  it('carries the mapping and the coordinate reminder', () => {
    const [text] = render({
      backend: 'native',
      displayIndex: 2,
      mapping: 'screenshot 1440x900 px · display 1440x900 pt',
      executed: [],
      image: IMAGE,
    })
    assert.match(text.text, /<screen backend="native" display="2">/)
    assert.match(text.text, /mapped onto the display automatically/)
  })

  it('surfaces a backend note when there is one', () => {
    const [text] = render({
      backend: 'applescript',
      displayIndex: 0,
      mapping: 'screenshot 1470x956 px',
      executed: [],
      note: 'Using the AppleScript fallback backend.',
      image: IMAGE,
    })
    assert.match(text.text, /AppleScript fallback/)
  })
})
