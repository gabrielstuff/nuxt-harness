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
 *
 * Two shapes are bounded by construction and not reported: a `{ once: true }` listener (it
 * removes itself on the first event), and a timer the same function clears in a `finally`
 * block (it cannot outlive the call that started it, e.g. a request timeout).
 */

import { docsUrl } from './docs.js'

const STOPPERS = [
  'tryOnScopeDispose', 'onScopeDispose', 'onUnmounted', 'onBeforeUnmount',
  'useDebounceFn', 'useThrottleFn', 'useEventListener', 'useTimeoutFn', 'useIntervalFn',
  'useTimeoutPoll', 'useRafFn'
]
const TIMERS = new Set(['setTimeout', 'setInterval', 'addEventListener'])
const CLEARS = new Set(['clearTimeout', 'clearInterval'])
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** @param {any} node */
const calleeName = node => node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name

/** `addEventListener(type, fn, { once: true })` removes itself after the first event. @param {any} node */
function isOnceListener (node) {
  const options = node.arguments?.[2]
  return options?.type === 'ObjectExpression' && options.properties.some((/** @type {any} */ p) =>
    p.type === 'Property' && (p.key?.name ?? p.key?.value) === 'once' && p.value?.type === 'Literal' && p.value.value === true)
}

/** @param {any[]} ancestors @returns {any} the innermost enclosing function, or undefined at module level */
const enclosingFunction = ancestors => ancestors.findLast(a => FUNCTIONS.has(a.type))

/** @param {any[]} ancestors @param {any} node */
function insideFinally (ancestors, node) {
  const chain = [...ancestors, node]
  return chain.some((a, i) => a.type === 'TryStatement' && chain[i + 1] === a.finalizer)
}

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
    // Timer handles cleared in a `finally`, per enclosing function: `fn -> Set<handle name>`.
    /** @type {Map<any, Set<string>>} */
    const clearedInFinally = new Map()

    return {
      /** @param {any} node */
      CallExpression (node) {
        const name = calleeName(node)
        const ancestors = context.sourceCode.getAncestors(node)
        if (TIMERS.has(name) && !(name === 'addEventListener' && isOnceListener(node))) {
          const declarator = ancestors.at(-1)
          const handle = declarator?.type === 'VariableDeclarator' && declarator.id?.type === 'Identifier' ? declarator.id.name : undefined
          calls.push({ node, name, handle, fn: enclosingFunction(ancestors) })
        }
        if (STOPPERS.includes(name)) stoppers.add(name)
        const handle = node.arguments?.[0]
        if (CLEARS.has(name) && handle?.type === 'Identifier' && insideFinally(ancestors, node)) {
          const fn = enclosingFunction(ancestors)
          clearedInFinally.set(fn, (clearedInFinally.get(fn) ?? new Set()).add(handle.name))
        }
      },
      /** @param {any} node */
      'Program:exit' () {
        if (stoppers.size > 0) return
        const unbounded = calls.filter(c => !(c.handle && clearedInFinally.get(c.fn)?.has(c.handle)))
        if (unbounded.length === 0) return
        const first = unbounded[0]
        context.report({ node: first.node, messageId: 'needsDispose', data: { what: first.name } })
      }
    }
  }
}
