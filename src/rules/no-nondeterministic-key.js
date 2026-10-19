// @ts-check
/**
 * ESLint Rule: no-nondeterministic-key
 *
 * Flags a request key (useFetch / useAsyncData `key`) built from a value the client cannot
 * reproduce identically: `Date.now()`, `new Date().getTime()`, `Math.random()`,
 * `performance.now()`, `crypto.randomUUID()`.
 *
 * The key is how hydration finds the server's payload entry. A key derived from the clock
 * or the timezone differs between the Node process and the browser, so the client misses
 * the cache and refetches - the list flashes out and back in.
 */

const DOC = 'https://github.com/edumapper/nuxt-harness/blob/main/skills/nuxt-harness/references/eslint-rules.md#no-nondeterministic-key'

/** @param {any} node @returns {boolean} */
function isNondeterministic (node) {
  /** @type {any[]} */
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current.type !== 'string') continue

    if (current.type === 'NewExpression' && current.callee?.name === 'Date') return true
    if (current.type === 'CallExpression') {
      const callee = current.callee
      if (callee?.type === 'Identifier' && callee.name === 'randomUUID') return true
      if (callee?.type === 'MemberExpression') {
        const property = callee.property?.name ?? callee.property?.value
        const receiver = callee.object?.name
        if (receiver === 'Date' && ['now', 'parse'].includes(property)) return true
        if (receiver === 'Math' && property === 'random') return true
        if (receiver === 'performance' && property === 'now') return true
        if (receiver === 'crypto' && property === 'randomUUID') return true
        // a receiver that is itself `new Date(...)` / `Date.now()` etc.
        if (['getTime', 'valueOf', 'toISOString', 'toLocaleString', 'toLocaleDateString'].includes(property)) {
          const object = callee.object
          if (object?.type === 'NewExpression' && object.callee?.name === 'Date') return true
          if (object?.type === 'CallExpression' && object.callee?.object?.name === 'Date') return true
          if (object?.type === 'Identifier' && object.name === 'Date') return true
        }
      }
    }
    for (const key of Object.keys(current)) {
      if (key === 'parent') continue
      const value = current[key]
      if (Array.isArray(value)) stack.push(...value)
      else if (value && typeof value === 'object' && typeof value.type === 'string') stack.push(value)
    }
  }
  return false
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require a request key the client can reproduce' },
    schema: [],
    messages: {
      nondeterministic: [
        '❌ key derived from a clock or random value: {{what}}',
        '💡 Server and client must compute the same key: the payload entry the server wrote is found by key during hydration. A key from Date/Math.random differs per render, so the client misses the cache, refetches, and the content flashes.',
        '🛠 Build the key from a value both sides compute identically: a formatted local calendar string, an id from the route, a normalized filter object.',
        '📖 ' + DOC
      ].join('\n')
    }
  },
  create (context) {
    /** @param {any} node @param {string} what */
    function report (node, what) {
      context.report({
        node,
        messageId: 'nondeterministic',
        data: { what: what.slice(0, 48) }
      })
    }

    return {
      /** @param {any} node */
      CallExpression (node) {
        const callee = node.callee?.type === 'Identifier' ? node.callee.name : null
        if (callee !== 'useAsyncData' && callee !== 'useLazyAsyncData') return
        const first = node.arguments?.[0]
        // useAsyncData(key, handler, options): a literal or identifier key is fine, a computed
        // key expression must still be reproducible on the client.
        if (!first) return
        if (first.type === 'Literal' || first.type === 'Identifier') return
        if (first.type === 'ObjectExpression') return
        if (!isNondeterministic(first)) return
        report(first, context.sourceCode.getText(first))
      },
      /** @param {any} node */
      Property (node) {
        const name = node.key?.name ?? node.key?.value
        if (name !== 'key') return
        if (!isNondeterministic(node.value)) return
        report(node.value, context.sourceCode.getText(node.value))
      }
    }
  }
}
