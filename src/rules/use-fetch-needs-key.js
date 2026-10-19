// @ts-check
/**
 * ESLint Rule: use-fetch-needs-key
 *
 * Flags `useFetch`/`useAsyncData` that take `query`/`params` without a `key`.
 *
 * Without a key the request is identified by call order, not by its arguments: a second
 * caller with different filters shares the first caller's payload entry, and hydration
 * replays the wrong data. With a key, the framework supersedes the previous request and
 * reuses the cache instead of refetching.
 */

const DOC = 'https://github.com/edumapper/nuxt-harness/blob/main/skills/nuxt-harness/references/eslint-rules.md#use-fetch-needs-key'
const DATA_COMPOSABLES = ['useFetch', 'useAsyncData', 'useLazyFetch', 'useLazyAsyncData']

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require a key on parameterised useFetch/useAsyncData calls' },
    schema: [],
    messages: {
      needsKey: [
        '❌ {{callee}}(...) with {{what}} but no key',
        '💡 Without a key the payload entry is identified by call order, not by the arguments: two callers with different filters collide, and hydration replays whichever was cached first.',
        '🛠 Pass a deterministic key, e.g. key: () => `search:${q}` (no clock, no random).',
        '📖 ' + DOC
      ].join('\n')
    }
  },
  create (context) {
    return {
      /** @param {any} node */
      CallExpression (node) {
        const callee = node.callee?.type === 'Identifier' ? node.callee.name : null
        if (!callee || !DATA_COMPOSABLES.includes(callee)) return
        const args = node.arguments ?? []
        const options = args.find((arg) => arg?.type === 'ObjectExpression')
        if (!options) return
        const props = options.properties ?? []
        const has = (name) => props.some((p) => (p.key?.name ?? p.key?.value) === name)
        const what = has('query') ? 'query' : has('params') ? 'params' : null
        if (!what || has('key')) return
        // useAsyncData(key, handler, options): a first argument that is not the options object is the key
        if (callee === 'useAsyncData' || callee === 'useLazyAsyncData') {
          const first = args[0]
          if (first && first !== options) return
        }
        context.report({ node, messageId: 'needsKey', data: { callee, what } })
      }
    }
  }
}
