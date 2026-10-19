# ESLint rules — `@edumapper/nuxt-harness/eslint`

Source of truth: [`src/eslint.js`](../../../src/eslint.js). This page explains why each rule exists.
All rules are `error` unless noted. Messages follow ❌ what → 💡 why → 🛠 fix → 📖 doc.

Globs below use the Nuxt 4 layout. Every rule also applies inside Nuxt layers
(`layers/<name>/app/…`), and follows `srcDir: '.'` for apps that kept the Nuxt 3 layout.
Options are described in [configuration.md](configuration.md).

## Entry points

| Export | Used by | Contents |
|---|---|---|
| `harness(options?)` | the app's `eslint.config.mjs`, spread into `withNuxt(...)` | every rule below except the type-aware ones. It does not redefine the `vue`/`@typescript-eslint` plugins that Nuxt registers. |
| `typeAware(rootDir, options?)` | the app's `eslint.config.mjs` (full gate) | rules that need the TypeScript program (`projectService`). They need `.nuxt/` to be meaningful. |
| `standalone(options?)` | `nuxt-harness fast` | parsers and plugins from the package's own dependencies, plus `harness()`. No `.nuxt/`, no app install. |

## Architecture: the 5-layer model

| Rule | Files | Forbids |
|---|---|---|
| `arch/no-presenter-in-page` (R0) <a id="no-presenter-in-page"></a> | `app/pages/**/*.vue` | rendering anything but Orchestrators/Operators, HTML, Vue/Nuxt built-ins (`Nuxt*`) and Nuxt UI atoms (`U*`). Directory-prefixed (`<ShopOrcCart>`), lazy (`<LazyOrcCart>`) and kebab-case names are recognized. |
| `arch/no-smart-calls` (R1/R2) <a id="no-smart-calls"></a> | Presenters | stores (`use*Store`), `useRouter`/`useRoute`/`navigateTo`, `useFetch`/`useAsyncData`/`$fetch`, query primitives (`useQuery`, `useMutation`, …) and the app's `dataComposables` |
| `arch/no-data-calls-in-operator` (R3) <a id="no-data-calls-in-operator"></a> | `Op*.vue` | raw data primitives (`$fetch`, `useFetch`, `useAsyncData`, `useQuery`, …). Call a composable. |
| `arch/no-reverse-layer` (R4) | components | upward imports: Presenter → Op/Orc, Op → Orc |
| `arch/no-server-ui-import` | `server/**` | importing Vue components or pages |

Template rules must use `context.sourceCode.parserServices.defineTemplateBodyVisitor`. A top-level
`VElement`/`VAttribute` visitor is never called; `test/rules.test.ts` guards every template rule
with an invalid case.

## Locality

| Rule | Files | Forbids |
|---|---|---|
| `@typescript-eslint/no-restricted-imports` | `app/**` | `~~/server/**` (type imports allowed; exceptions via `allowServerImportsInApp`). Share schemas and types through `shared/`. |
| | `server/**` | `~/**`, `~~/app/**`, `#app`, `#components` |
| | `shared/**` | app and server code: `shared/` stays isomorphic |
| | all | event buses: `mitt`, `tiny-emitter`, `eventemitter3`, `events` |
| `no-restricted-syntax` (only with i18n) | `app/**` | `navigateTo('/…')` / `` navigateTo(`/…`) ``. Use `localePath({ name })`. |
| `arch/no-provide-inject` <a id="no-provide-inject"></a> | `app/**` | Vue `provide()`/`inject()`/`vueApp.provide`. Pass props down or share a composable. Nuxt plugin `provide` stays allowed. |
| `arch/no-auth-gate-outside-middleware` <a id="no-auth-gate-outside-middleware"></a> | components, pages, layouts | a branch that reads an auth composable (`authComposables`, default `useUserSession`, `useAuth`, `useSupabaseUser`, `useSupabaseSession`) and redirects. Access policy lives in route middleware. Displaying the user is fine. |
| `arch/no-bare-navigate` | `app/**` | `navigateTo()` that is not awaited or returned, unless a comment on the line above (or at the end of the line) explains why; `router.push/replace/go` |

## Structural invariants & illegal states

| Rule | Why |
|---|---|
| `@typescript-eslint/no-explicit-any` | `any` switches the compiler off for everything it touches |
| `vue/define-props-declaration: type-based`, `vue/define-emits-declaration: type-based` | runtime declarations lose literal and union types |
| `vue/require-typed-ref` | `ref()` without a value or type parameter is `Ref<any>` |
| `vue/no-setup-props-reactivity-loss` | destructuring `props` at setup root freezes the value |
| `arch/max-boolean-props` <a id="max-boolean-props"></a> | 3+ boolean props encode 2^N states, most of them illegal. Use one discriminated union prop. |
| `@typescript-eslint/switch-exhaustiveness-check` (type-aware) | adding a union member must break every switch that forgot it |
| `@typescript-eslint/no-unnecessary-condition` (type-aware) | a condition the types prove constant is dead code or a lying type |
| `@typescript-eslint/no-unnecessary-type-assertion` (type-aware) | a cast the types already satisfy hides the real type |
| `@typescript-eslint/no-unsafe-return` (type-aware) | returning `any` leaks it into every caller |

## Guards & reactivity

Principle: use early returns for states that really happen. Don't check states the types or another layer already rule out.

| # | Rule | Enforced by |
|---|---|---|
| G1 | No checks for impossible states (`?.`, `??`, `if (!x)` on a non-nullable). If the type is wrong, fix the type. | `@typescript-eslint/no-unnecessary-condition`, `no-unnecessary-type-assertion` (type-aware) |
| G2 | A guard with more than 2 operands goes into a named `computed` or function, ideally one returning the blocking reason. | `arch/max-condition-operands` <a id="max-condition-operands"></a> (counts every `&&`/`\|\|` leaf, including right-nested `a \|\| (b && c)`; `??` is not counted) |
| G3 | Exit early. No `else` after a return, no deep nesting. | `no-else-return` (`allowElseIf: false`), `max-depth: 2` |
| G4 | Gates live with their owner: auth checks and redirects go in route middleware. | `arch/no-auth-gate-outside-middleware` |
| G5 | A `v-if`/`v-else-if`/`v-show` with more than 2 operands becomes a computed. | `arch/max-condition-operands` |
| G6 | Async handlers set the lock before the first `await`. | code review, not lintable |
| | No more than 3 watchers per file. Derived state is a `computed`; a reaction to a user action goes in that handler; prop sync uses `defineModel`. | `arch/max-watchers` <a id="max-watchers"></a> |
| | Every `<ClientOnly>` is directly preceded by an HTML comment (4+ words) saying why the subtree can't render on the server. | `arch/client-only-needs-reason` <a id="client-only-needs-reason"></a> |

## Control flow & size

| Rule | Why |
|---|---|
| `no-unsafe-finally` | `return`/`throw` in `finally` silently discards the in-flight error |
| `no-empty` (incl. catch) | `catch {}` swallows errors |
| `complexity: 20` | the C in CRAP. Above it, split the function. |
| `max-params: 4` | the cheapest SRP smell to detect (off in tests) |
| `arch/no-figma-asset-url` | expiring Figma MCP asset URLs (`figma.com/api/mcp/asset/…`, `localhost:3845/assets/…`) ship as broken images |

## SSR determinism

What the server renders must be what the client renders, and what the client fetches must be
findable in the payload. These rules catch the classes that SSR HTML, `curl` and `nuxt typecheck`
cannot see - the page returns 200 with correct HTML and breaks in a browser.

| Rule | Files | Forbids |
|---|---|---|
| `arch/no-reserved-item-value` <a id="no-reserved-item-value"></a> | `app/**` | a script-level item object with `value: ''`. Select-like components (Reka UI: `USelect`, `USelectMenu`, `UInputMenu`) reserve the empty string for "clear selection" and throw while *rendering* that item, so hydration replaces the page with the error page. Use a sentinel (`const ALL = 'all'`) and map it to `undefined` at the query/URL boundary. Template literals are exempt: `<option value="">` is valid. |
| `arch/no-nondeterministic-key` <a id="no-nondeterministic-key"></a> | `app/**`, `server/**` | a request key built from `Date.now()`, `new Date().getTime()`, `Math.random()`, `performance.now()`, `crypto.randomUUID()` - in `key:` or as the first argument of `useAsyncData`. Node and the browser compute different values, the client misses the payload entry and refetches (content flashes out and back). |
| `arch/use-fetch-needs-key` <a id="use-fetch-needs-key"></a> | `app/**` | `useFetch` / `useAsyncData` with `query` or `params` and no `key` (warn). Without a key the payload entry is identified by call order, so two callers with different filters collide. |
| `arch/no-locale-format-in-render` <a id="no-locale-format-in-render"></a> | `app/**` | `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` / `Intl.*` in a template expression or a top-level setup statement (calls inside functions are client-only and exempt). Node and the browser ship different ICU data, so grouping, month names and time zones can differ between the two renders - and production Vue does not warn about a hydrated text mismatch. |
| `arch/no-browser-api-in-setup` <a id="no-browser-api-in-setup"></a> | `app/**`, `server/**` | `window` / `document` / `localStorage` / `sessionStorage` / `navigator` read at the top level of setup, outside a function and outside an `import.meta.client` guard. Move the work into `onMounted`, guard the branch, or use `<ClientOnly>` with a reason. |
| `arch/no-module-mutable-state` <a id="no-module-mutable-state"></a> | `app/**`, `server/**` (`.ts` modules; SFC setup bodies are per instance and exempt) | a module-scope `ref` / `reactive` / `shallowRef` / `computed`, or a module-scope `let` assigned in two or more places. A module is one instance per server process, so this is cross-request state: use `useState`, `useCookie`, route state, or scope a shared instance per Nuxt app. A cache assigned exactly once from an immutable source is fine. |
| `arch/timer-needs-scope-dispose` <a id="timer-needs-scope-dispose"></a> | `app/**` | `setTimeout` / `setInterval` / `addEventListener` in a file with no `tryOnScopeDispose` / `onScopeDispose` / `onUnmounted` / VueUse helper (warn). Prefer `useDebounceFn`, `useEventListener`, `useTimeoutFn`, `useIntervalFn` - they cancel on scope dispose. |

## Design system (opt-in)

Off by default — the harness ships no design tokens. Enable with `designSystem` in
[configuration](configuration.md#design-system). Applies to `app/**/*.vue`.

| Rule | Enabled by | Forbids |
|---|---|---|
| `arch/no-hardcoded-color` | `designSystem` (unless `hardcodedColors: false`) | hex/rgb/hsl in `class`, `style` or string literals. Use token classes or `var(--color-*)`. |
| `arch/no-off-palette-color-class` <a id="no-off-palette-color-class"></a> | `designSystem.palettes` | Tailwind built-in palettes (`gray`, `sky`, …) not listed in `palettes`. Custom palettes are never flagged. |
| `arch/no-nested-border-box` (warn) | `designSystem` (unless `nestedBorderBox: false`) | bordered, rounded boxes inside other bordered surfaces (`surfaceComponents`, default Nuxt UI cards and overlays) |

## Static checks (not ESLint)

Plain file scans in [`src/checks.js`](../../../src/checks.js), run by both gates. The code checks
read code and strings only: comments are skipped (HTML comments too, in `.vue` templates). Escape
hatches and TODO markers read comments, since that is what they check. Existing errors can be
recorded with `nuxt-harness full --update-baseline` (`nuxt-harness-baseline.json`, per check and
file; warnings are never recorded).

| Check | Reports |
|---|---|
| Import hygiene | `../../` deep relative imports, `./index` barrel imports |
| Escape hatches | `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`; blanket `eslint-disable`; any disable of a harness rule; other disables without `-- reason` |
| Console hygiene | `console.log/debug/info` outside tests (`warn`/`error` allowed) |
| Secret scan | Stripe keys, hardcoded passwords/API keys/tokens, long base64 literals |
| Unvalidated `readBody` | `readBody()` (and the app's `bodyReaders`) in `server/` whose result isn't `.parse()`d within 3 lines. Prefer `readValidatedBody`. |
| i18n keys | static `t('a.b')` keys missing from any JSON file in `i18n/locales/` (or `locales/`) |
| TODO markers | `TODO`/`FIXME`/`HACK` (warning) |

## Considered and not adopted (yet)

- `exactOptionalPropertyTypes`: valuable, but produces many type errors on existing apps, and TS errors can't be bulk-suppressed. Worth enabling on a new app.
- `strict-boolean-expressions`: mostly style noise. `no-unsafe-assignment/call/member-access`: noisy on auto-imports when types can't be resolved.
- dependency-cruiser: Nuxt auto-imports components and composables, so the import graph it sees is incomplete. The layer and locality rules above cover the edges that exist as imports.

## Rights matrix

| Action | Presenter | Operator | Orchestrator | Page |
|---|---|---|---|---|
| Use a store | ✕ R1 | ✓ | ✓ | ✓ read |
| `useRouter()` / `navigateTo()` | ✕ R2 | ✓ | ✓ | ✓ |
| `useFetch()` / `useAsyncData()` / `$fetch` | ✕ R2 | ✕ R3 | via a composable | ✕ |
| Render a Presenter | ✓ | ✓ | ✓ | ✕ R0 |
| Import an Op / Orc | ✕ R4 | Op only | ✓ | ✓ |
