/**
 * dsh-plugin-computer-use — Codex-style computer use for DeepSeek Harness.
 *
 * A Cordis plugin that registers one model-facing tool, `computer`, whose action
 * vocabulary and batch contract mirror OpenAI's computer tool. On macOS the
 * actions are posted by a small Objective-C helper compiled from source on first
 * use, with an AppleScript fallback for machines without a toolchain.
 *
 * The plugin provides no service and owns no process-wide state: it registers a
 * tool and a prompt section into the calling scope, so a preset can mount it per
 * session and unmount it cleanly.
 *
 * @module dsh-plugin-computer-use
 */

import { resolveConfig } from './config.js'
import { COMPUTER_USE_ORDER, COMPUTER_USE_POLICY, COMPUTER_USE_SECTION } from './prompt.js'
import { createComputerTool } from './tool.js'

/** Stable Loader identity. */
export const name = 'tool-computer-use'

/**
 * The one hard dependency.
 *
 * `attachments` and `systemPrompt` are read with `ctx.get` at call time instead:
 * a deployment may legitimately run without a durable attachment store, and the
 * tool should report that clearly rather than silently never registering.
 */
export const inject = ['tools']

/**
 * Register the `computer` tool and its policy section.
 *
 * @param {object} ctx - the agent-scoped plugin context.
 * @param {unknown} rawConfig - the composition row's `config` block, if any.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  ctx.tools.register(createComputerTool({ ctx, config }))

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: COMPUTER_USE_SECTION,
          order: COMPUTER_USE_ORDER,
          text: COMPUTER_USE_POLICY,
        }),
      'computer-use.policy()',
    )
  }
}

export { DEFAULT_CONFIG, ACTION_TYPES } from './config.js'
export { COMPUTER_TOOL_DESCRIPTION } from './tool.js'
