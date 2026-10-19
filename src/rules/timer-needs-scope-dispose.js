// @ts-check
/**
 * ESLint Rule: timer-needs-scope-dispose
 *
 * Flags a file that starts a timer or a listener (`setTimeout`, `setInterval`,
 * `addEventListener`) without any scope-aware cleanup or helper in the same file.
 *
 * A pending timer or listener outlives the component that created it: it keeps running
 * after unmount, and in a composable it fires into a scope that no longer exists. VueUse
 * helpers cancel themselves on scope dispose, which is why they are the suggested fix.
 */

import { docsUrl } from './docs.js'

const STOPPERS = [
  'tryOnScopeDispose', 'onScopeDispose', 'onUnmounted', 'onBeforeUnmount',
  'useDebounceFn', 'useThrottleFn', 'useEventListener', 'useTimeoutFn', 'useIntervalFn',
  'useTimeoutPoll', 'useRafFn'
]
const TIMERS = new Set(['setTimeout', 'setInterval', 'addEventListener'])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require scope-aware cleanup for timers and listeners' },
    schema: [],
    messages: {
      needsDispose: [
        '❌ {{what}} without a scope-aware cleanup in this file',
        '💡 A pending timer or listener outlives the component: it keeps running after unmount, or fires into a composable scope that no longer exists.',
        '🛠 Prefer the helper that owns the cleanup (useDebounceFn, useEventListener, useTimeoutFn, useIntervalFn) - they cancel on scope dispose. Otherwise call tryOnScopeDispose(() => clearTimeout(id)) in a composable, onUnmounted in a component.',
        '📖 ' + docsUrl('timer-needs-scope-dispose')
      ].join('\n')
    }
  },
  create (context) {
    /** @type {any[]} */
    const calls = []
    /** @type {Set<string>} */
    const stoppers = new Set()

    return {
      /** @param {any} node */
      CallExpression (node) {
        const callee = node.callee
        const name = callee?.type === 'Identifier' ? callee.name : callee?.property?.name
        if (TIMERS.has(name)) calls.push({ node, name })
        if (STOPPERS.includes(name)) stoppers.add(name)
        if (callee?.type === 'Identifier' && STOPPERS.includes(callee.name)) stoppers.add(callee.name)
      },
      /** @param {any} node */
      'Program:exit' () {
        if (calls.length === 0 || stoppers.size > 0) return
        const first = calls[0]
        context.report({ node: first.node, messageId: 'needsDispose', data: { what: first.name } })
      }
    }
  }
}
