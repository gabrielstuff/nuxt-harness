// @ts-check
/**
 * ESLint Rule: no-module-mutable-state
 *
 * Flags module-scope shared state in `app/composables` and `server`:
 *   - a reactive singleton (`ref` / `reactive` / `shallowRef` / `shallowReactive` at module scope);
 *   - a module-scope `let` that is assigned in more than one place.
 *
 * Under SSR a module is one instance for the whole process, so a reactive singleton is
 * cross-request state: whatever request N+1 reads is what request N wrote. A value derived
 * once from a file and never reassigned is fine - that is an immutable cache. A module-scope
 * `computed` holds no state of its own: it derives from a source that is reported instead, so one
 * singleton is one finding.
 *
 * SFC files are skipped: the top level of <script setup> is setup scope (one per instance),
 * which is exactly where component state belongs. This rule targets `app/composables`,
 * `app/utils`, `server` and other real modules.
 */

import { docsUrl } from './docs.js'

const REACTIVE = new Set(['ref', 'reactive', 'shallowRef', 'shallowReactive'])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow request-crossing module state' },
    schema: [],
    messages: {
      reactiveSingleton: [
        '❌ {{name}} is a reactive singleton at module scope',
        '💡 A module is one instance per server process: this value is shared by every request and every user, so one request reads what another wrote.',
        '🛠 Use useState for state the payload must carry, useCookie for things that survive a reload, or scope a shared instance per Nuxt app (useNuxtApp() + WeakMap + effectScope(true)). A value derived once from a file and never reassigned is fine.',
        '📖 ' + docsUrl('no-module-mutable-state')
      ].join('\n'),
      reassigned: [
        '❌ module-scope {{name}} is assigned in {{count}} places',
        '💡 Module scope is process scope: under SSR the value is shared across requests. A cache written once from an immutable source is fine; anything a request can change is not.',
        '🛠 Keep request data in useState / the event context, or make the module value immutable and assign it exactly once.',
        '📖 ' + docsUrl('no-module-mutable-state')
      ].join('\n')
    }
  },
  create (context) {
    // In an SFC the top-level <script setup> body is setup scope (per instance), not module scope.
    if (context.filename && context.filename.endsWith('.vue')) return {}

    /** @type {Map<string, any>} */
    const moduleLets = new Map()
    /** @type {Map<string, number>} */
    const assignments = new Map()

    return {
      /** @param {any} node */
      Program (node) {
        for (const raw of node.body) {
          const statement = raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration'
            ? raw.declaration
            : raw
          if (!statement || statement.type !== 'VariableDeclaration') continue
          const isLet = statement.kind === 'let'
          for (const declarator of statement.declarations ?? []) {
            const id = declarator.id
            if (id?.type !== 'Identifier') continue
            const init = declarator.init
            if (init?.type === 'CallExpression' && REACTIVE.has(init.callee?.name)) {
              context.report({ node: declarator, messageId: 'reactiveSingleton', data: { name: id.name } })
              continue
            }
            if (isLet) moduleLets.set(id.name, declarator)
          }
        }
      },
      /** @param {any} node */
      AssignmentExpression (node) {
        const target = node.left
        const name = target?.type === 'Identifier'
          ? target.name
          : (target?.type === 'MemberExpression' && target.object?.type === 'Identifier' ? target.object.name : null)
        if (!name) return
        assignments.set(name, (assignments.get(name) ?? 0) + 1)
      },
      /** @param {any} node */
      'Program:exit' () {
        for (const [name, declarator] of moduleLets) {
          const count = assignments.get(name) ?? 0
          if (count >= 2) {
            context.report({ node: declarator, messageId: 'reassigned', data: { name, count: String(count) } })
          }
        }
      }
    }
  }
}
