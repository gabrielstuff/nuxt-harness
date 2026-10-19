// @ts-check
/**
 * ESLint Rule: no-browser-api-in-setup
 *
 * Flags `window` / `document` / `localStorage` / `sessionStorage` / `navigator` read at the
 * top level of `setup`, i.e. outside a function and without an `import.meta.client` guard.
 *
 * Setup runs on the server during SSR. A top-level read either throws (500 for every
 * visitor) or renders a different value than the client, which is the mismatch class this
 * rule exists to prevent. Move the work into `onMounted`, or guard the branch.
 */

import { docsUrl } from './docs.js'

const GLOBALS = new Set(['window', 'document', 'localStorage', 'sessionStorage', 'navigator'])
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'PropertyDefinition', 'MethodDefinition', 'StaticBlock'
])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow browser globals at the top level of setup' },
    schema: [],
    messages: {
      browserApi: [
        '❌ {{name}} read during setup',
        '💡 Setup runs on the server: a top-level browser read throws during SSR (or renders a different value than the client).',
        '🛠 Move the work into onMounted, or guard the branch with `if (import.meta.client)`; for a whole subtree use <ClientOnly> with a reason.',
        '📖 ' + docsUrl('no-browser-api-in-setup')
      ].join('\n')
    }
  },
  create (context) {
    /** @type {Set<any>} */
    const guarded = new Set()
    /** @param {any} node */
    function markGuardedText (node) {
      const test = node.test
      if (!test) return
      const text = context.sourceCode.getText(test)
      if (text.includes('import.meta.client') || text.includes('import.meta.server') || text.startsWith('typeof ')) {
        for (const child of node.consequent ? [node.consequent] : []) guarded.add(child)
        if (node.alternate) guarded.add(node.alternate)
      }
    }

    const program = context.sourceCode.ast
    // collect guarded blocks first (they may appear after the read in source order)
    /** @type {any[]} */
    const stack = [program]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node || typeof node.type !== 'string') continue
      if (node.type === 'IfStatement') markGuardedText(node)
      for (const key of Object.keys(node)) {
        if (key === 'parent') continue
        const value = node[key]
        if (Array.isArray(value)) stack.push(...value)
        else if (value && typeof value === 'object' && typeof value.type === 'string') stack.push(value)
      }
    }

    return {
      /** @param {any} node */
      Program (node) {
        /** @param {any} current @param {boolean} inFunction @param {boolean} inGuard */
        function walk (current, inFunction, inGuard) {
          if (!current || typeof current.type !== 'string') return
          if (FUNCTION_TYPES.has(current.type)) return
          const nowInGuard = inGuard || guarded.has(current)
          if (!inFunction && !nowInGuard && current.type === 'Identifier' && GLOBALS.has(current.name)) {
            const parent = current.parent
            const isDeclarationOrProperty =
              (parent?.type === 'VariableDeclarator' && parent.id === current) ||
              ((parent?.type === 'MemberExpression' || parent?.type === 'Property') && parent.property === current && parent.type === 'Property')
            if (!isDeclarationOrProperty) {
              context.report({ node: current, messageId: 'browserApi', data: { name: current.name } })
              return
            }
          }
          for (const key of Object.keys(current)) {
            if (key === 'parent') continue
            const value = current[key]
            if (Array.isArray(value)) for (const child of value) walk(child, inFunction, nowInGuard)
            else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, inFunction, nowInGuard)
          }
        }
        walk(node, false, false)
      }
    }
  }
}
