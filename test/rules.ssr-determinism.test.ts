import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'
import vueParser from 'vue-eslint-parser'

import noBrowserApiInSetup from '../src/rules/no-browser-api-in-setup.js'
import noLocaleFormatInRender from '../src/rules/no-locale-format-in-render.js'
import noModuleMutableState from '../src/rules/no-module-mutable-state.js'
import noNondeterministicKey from '../src/rules/no-nondeterministic-key.js'
import noReservedItemValue from '../src/rules/no-reserved-item-value.js'
import timerNeedsScopeDispose from '../src/rules/timer-needs-scope-dispose.js'
import useFetchNeedsKey from '../src/rules/use-fetch-needs-key.js'

// Every rule below exists because a real application shipped the bug it prevents, and because
// SSR HTML + curl + `nuxt typecheck` all stayed green while the browser did not. Each rule has a
// positive and a negative fixture, so the gate is guarded against silent regressions.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.afterAll = afterAll

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } })
const vueTester = new RuleTester({
  languageOptions: { parser: vueParser, parserOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' } }
})
const sfc = (script: string, template = '<div />') => `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n  ${template}\n</template>\n`

// The empty string is reserved by select-like components (Reka UI): rendering such an item throws
// during hydration. SSR, curl and typecheck cannot see it - the browser gets an error page.
ruleTester.run('no-reserved-item-value', noReservedItemValue, {
  valid: [
    { filename: 'app/pages/index.vue', code: 'const ALL = \'all\'; const items = [{ label: \'All\', value: ALL }]' },
    { filename: 'app/components/List.vue', code: 'const rows = [{ id: 1, value: 0 }]' }
  ],
  invalid: [
    { filename: 'app/pages/index.vue', code: 'const items = [{ label: \'All\', value: \'\' }]', errors: 1 },
    { filename: 'app/pages/index.vue', code: 'const items = [{ value: \'a\' }, { value: \'\' }]', errors: 1 }
  ]
})

// A native <option value=""> is legitimate, so template-side literals must stay clean.
vueTester.run('no-reserved-item-value (template)', noReservedItemValue, {
  valid: [{ filename: 'app/components/Select.vue', code: sfc('', '<select><option value="">All</option></select>') }],
  invalid: []
})

// Server and client must compute the same request key, or hydration misses the payload entry.
ruleTester.run('no-nondeterministic-key', noNondeterministicKey, {
  valid: [
    { filename: 'app/composables/useSearch.ts', code: 'useFetch(\'/api/s\', { key: () => `s:${q.value}`, query: { q } })' },
    { filename: 'app/composables/useSearch.ts', code: 'useAsyncData(() => `s:${id.value}`, () => $fetch(\'/api/s\'))' }
  ],
  invalid: [
    { filename: 'app/composables/useSearch.ts', code: 'useFetch(\'/api/s\', { key: () => `s:${Date.now()}` })', errors: 1 },
    { filename: 'app/composables/useSearch.ts', code: 'useAsyncData(() => `s:${new Date().getTime()}`, () => $fetch(\'/api/s\'), { key: () => String(Math.random()) })', errors: 2 }
  ]
})

// Without a key the payload entry is identified by call order, not by the arguments.
ruleTester.run('use-fetch-needs-key', useFetchNeedsKey, {
  valid: [
    { filename: 'app/composables/useSearch.ts', code: 'useFetch(\'/api/s\', { key: () => `s:${q.value}`, query: { q } })' },
    { filename: 'app/composables/useSearch.ts', code: 'useAsyncData(\'search\', () => $fetch(\'/api/s\'), { query: { q } })' },
    { filename: 'app/composables/useSearch.ts', code: 'useFetch(\'/api/s\')' }
  ],
  invalid: [
    { filename: 'app/composables/useSearch.ts', code: 'useFetch(\'/api/s\', { query: { q: 1 } })', errors: 1 },
    { filename: 'app/composables/useSearch.ts', code: 'useFetch(\'/api/s\', { params: { q: 1 } })', errors: 1 }
  ]
})

// Node and the browser ship different ICU data: a locale-formatted value in the render path can
// differ between renders, and production Vue does not warn about a hydrated text mismatch.
ruleTester.run('no-locale-format-in-render (script)', noLocaleFormatInRender, {
  valid: [
    { filename: 'app/pages/index.vue', code: 'const label = computed(() => String(total.value))' },
    { filename: 'app/pages/index.vue', code: 'function onClick () { return total.value.toLocaleString(\'fr-FR\') }' }
  ],
  invalid: [
    { filename: 'app/pages/index.vue', code: 'const label = new Date().toLocaleDateString()', errors: 1 },
    { filename: 'app/pages/index.vue', code: 'const label = total.value.toLocaleString(\'fr-FR\')', errors: 1 }
  ]
})

vueTester.run('no-locale-format-in-render (template)', noLocaleFormatInRender, {
  valid: [{ filename: 'app/pages/index.vue', code: sfc('const total = ref(0)', '<p>{{ total }}</p>') }],
  invalid: [{ filename: 'app/pages/index.vue', code: sfc('const total = ref(0)', '<p>{{ total.toLocaleString() }}</p>'), errors: 1 }]
})

// Setup runs on the server: a top-level browser read throws (500 for every visitor) or mismatches.
ruleTester.run('no-browser-api-in-setup', noBrowserApiInSetup, {
  valid: [
    { filename: 'app/pages/index.vue', code: 'onMounted(() => { const w = window.innerWidth })' },
    { filename: 'app/pages/index.vue', code: 'if (import.meta.client) { localStorage.setItem(\'a\', \'1\') }' },
    { filename: 'app/pages/index.vue', code: 'const theme = useCookie(\'theme\')' }
  ],
  invalid: [
    { filename: 'app/pages/index.vue', code: 'const w = window.innerWidth', errors: 1 },
    { filename: 'app/pages/index.vue', code: 'const saved = localStorage.getItem(\'a\')', errors: 1 }
  ]
})

// A timer without scope-aware cleanup outlives the component that created it.
ruleTester.run('timer-needs-scope-dispose', timerNeedsScopeDispose, {
  valid: [
    { filename: 'app/composables/usePoll.ts', code: 'const id = setInterval(tick, 1000); tryOnScopeDispose(() => clearInterval(id))' },
    { filename: 'app/composables/useSearch.ts', code: 'const run = useDebounceFn(search, 120)' },
    { filename: 'app/composables/useSearch.ts', code: 'useEventListener(window, \'resize\', onResize)' }
  ],
  invalid: [
    { filename: 'app/composables/usePoll.ts', code: 'const id = setInterval(tick, 1000)', errors: 1 },
    { filename: 'app/pages/index.vue', code: 'let t; watch(q, () => { clearTimeout(t); t = setTimeout(run, 120) })', errors: 1 }
  ]
})

// Under SSR a module is one instance per process: reactive singletons are cross-request state.
ruleTester.run('no-module-mutable-state', noModuleMutableState, {
  valid: [
    // an immutable cache written once is fine - this is the harness's own dataset pattern
    { filename: 'server/utils/rome.ts', code: 'let rows = null\nexport function get () { if (!rows) rows = load(); return rows }' }
  ],
  invalid: [
    { filename: 'app/composables/useFilters.ts', code: 'export const filters = ref({ q: \'\' })', errors: 1 },
    { filename: 'server/utils/session.ts', code: 'let user = null\nfunction setUser (u) { user = u }\nfunction clear () { user = null }', errors: 1 }
  ]
})

// A <script setup> body is setup scope (one per instance), not module scope.
vueTester.run('no-module-mutable-state (sfc skipped)', noModuleMutableState, {
  valid: [{ filename: 'app/pages/index.vue', code: sfc('const q = ref(\'\'); const total = computed(() => q.value.length)') }],
  invalid: []
})
