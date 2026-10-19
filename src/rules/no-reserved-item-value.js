// @ts-check
/**
 * ESLint Rule: no-reserved-item-value
 *
 * Flags a script-level object property `value: ''` - the empty string a select-like
 * design-system component reserves for "clear selection / show the placeholder".
 *
 * Nuxt UI's USelect / USelectMenu (Reka UI) throw while *rendering* such an item:
 *   "A <SelectItem /> must have a value prop that is not an empty string."
 * The throw happens during hydration, so SSR HTML, curl and `nuxt typecheck` all report
 * success while every browser gets an error page. Use a sentinel value and map it to
 * `undefined` at the query/URL boundary instead.
 *
 * Template object literals are not reported: a native `<option value="">` is legitimate.
 */

const DOC = 'https://github.com/edumapper/nuxt-harness/blob/main/skills/nuxt-harness/references/eslint-rules.md#no-reserved-item-value'

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow the reserved empty-string value in select-like item objects' },
    schema: [],
    messages: {
      reserved: [
        "❌ value: '' — the empty string is reserved by the component (\"clear selection\")",
        '💡 A select-like component reserves the empty string for "no selection / placeholder". Passing it as a real option throws while the client renders it — SSR, curl and typecheck stay green, every browser gets an error page.',
        "🛠 Use a sentinel: const ALL = 'all', item value ALL, and map ALL -> undefined at the query/URL boundary.",
        '📖 ' + DOC
      ].join('\n')
    }
  },
  create (context) {
    return {
      /** @param {any} node */
      Property (node) {
        const key = node.key
        const name = key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : null
        if (name !== 'value') return
        const value = node.value
        if (!value || value.type !== 'Literal' || value.value !== '') return

        // Skip template-side literals: a native <option value=""> is legitimate.
        for (const ancestor of context.sourceCode.getAncestors(node)) {
          if (ancestor.type === 'VElement' || ancestor.type === 'VAttribute') return
        }
        context.report({ node: value, messageId: 'reserved' })
      }
    }
  }
}
