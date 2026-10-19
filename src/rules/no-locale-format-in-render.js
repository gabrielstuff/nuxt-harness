// @ts-check
/**
 * ESLint Rule: no-locale-format-in-render
 *
 * Flags locale-dependent formatting in a template expression: `toLocaleString`,
 * `toLocaleDateString`, `toLocaleTimeString`, `Intl.*`.
 *
 * The template renders twice - once in Node, once in the browser - and the two runtimes
 * ship different ICU data. Grouping separators, month names and time zones can differ, so
 * the client render disagrees with the server HTML. In production Vue does not warn about
 * a hydrated text-node mismatch; it just re-renders and the user sees a flicker.
 */

import { docsUrl } from './docs.js'

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow locale-dependent formatting inside templates' },
    schema: [],
    messages: {
      localeFormat: [
        '❌ {{what}} in a template expression',
        '💡 The template renders on the server (Node) and again in the browser, with different ICU data: grouping, month names and time zones can differ, and Vue does not warn about a hydrated text mismatch in production.',
        '🛠 Format in one place and pass the string, or format with the app formatter once and render the result; if the value is inherently client-only, render it after mount.',
        '📖 ' + docsUrl('no-locale-format-in-render')
      ].join('\n')
    }
  },
  create (context) {
    const services = context.sourceCode.parserServices
    const LOCALE_CALL = /\b(toLocaleString|toLocaleDateString|toLocaleTimeString)\s*\(/
    const INTl_MEMBER = /\bIntl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat|PluralRules)\b/
    const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition', 'PropertyDefinition', 'StaticBlock'])

    // Script side: a top-level setup statement formats a value the template then renders, which
    // is the same Node-vs-browser divergence. Calls inside functions (event handlers, actions) are
    // client-only by construction and are not reported.
    const scriptVisitor = {
      /** @param {any} node */
      Program (node) {
        /** @param {any} current */
        function walk (current) {
          if (!current || typeof current.type !== 'string') return
          if (FUNCTION_TYPES.has(current.type)) return
          if (current.type === 'CallExpression' || current.type === 'NewExpression') {
            const text = context.sourceCode.getText(current)
            const match = text.match(LOCALE_CALL) || text.match(INTl_MEMBER)
            if (match) context.report({ node: current, messageId: 'localeFormat', data: { what: match[0].replace(/\s*\($/, '') } })
            return
          }
          for (const key of Object.keys(current)) {
            if (key === 'parent' || key === 'templateBody') continue
            const value = current[key]
            if (Array.isArray(value)) for (const child of value) walk(child)
            else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value)
          }
        }
        walk(node)
      }
    }

    if (!services.defineTemplateBodyVisitor) return scriptVisitor
    return services.defineTemplateBodyVisitor({
      /** @param {any} node */
      VExpressionContainer (node) {
        if (!node.expression) return
        const text = context.sourceCode.getText(node.expression)
        const match = text.match(/\b(toLocaleString|toLocaleDateString|toLocaleTimeString)\s*\(/) || text.match(/\bIntl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat|PluralRules)\b/)
        if (!match) return
        context.report({ node, messageId: 'localeFormat', data: { what: match[0].replace(/\s*\($/, '') } })
      }
    }, scriptVisitor)
  }
}
