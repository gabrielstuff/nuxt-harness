// @ts-check
/**
 * @edumapper/nuxt-harness — ESLint flat config.
 *
 * Three entry points:
 *   - `harness(options)`    rule blocks only. Spread into `withNuxt(...)` — the
 *                           Nuxt config already registers the `vue` and
 *                           `@typescript-eslint` plugins, so they are not redefined here.
 *   - `typeAware(rootDir)`  rules that need the TypeScript program. Full gate only:
 *                           they need `nuxt prepare` (auto-import types) to be meaningful.
 *   - `standalone(options)` parsers + plugins + `harness()`. Used by `nuxt-harness fast`,
 *                           which lints without `.nuxt/` or the app's node_modules.
 *
 * Options are documented in ./config.js and skills/nuxt-harness/references/configuration.md.
 */
import { appGlobs, resolveOptions, rootGlobs } from './config.js'
import clientOnlyNeedsReason from './rules/client-only-needs-reason.js'
import maxBooleanProps from './rules/max-boolean-props.js'
import maxConditionOperands from './rules/max-condition-operands.js'
import maxWatchers from './rules/max-watchers.js'
import noAuthGateOutsideMiddleware from './rules/no-auth-gate-outside-middleware.js'
import noBareNavigate from './rules/no-bare-navigate.js'
import noDataCallsInOperator from './rules/no-data-calls-in-operator.js'
import noFigmaAssetUrl from './rules/no-figma-asset-url.js'
import noHardcodedColor from './rules/no-hardcoded-color.js'
import noNestedBorderBox from './rules/no-nested-border-box.js'
import noOffPaletteColorClass from './rules/no-off-palette-color-class.js'
import noPresenterInPage from './rules/no-presenter-in-page.js'
import noProvideInject from './rules/no-provide-inject.js'
import noReverseLayerImport from './rules/no-reverse-layer-import.js'
import noServerUiImport from './rules/no-server-ui-import.js'
import noBrowserApiInSetup from './rules/no-browser-api-in-setup.js'
import noLocaleFormatInRender from './rules/no-locale-format-in-render.js'
import noModuleMutableState from './rules/no-module-mutable-state.js'
import noNondeterministicKey from './rules/no-nondeterministic-key.js'
import noReservedItemValue from './rules/no-reserved-item-value.js'
import timerNeedsScopeDispose from './rules/timer-needs-scope-dispose.js'
import useFetchNeedsKey from './rules/use-fetch-needs-key.js'
import noSmartCallsInPresenter from './rules/no-smart-calls-in-presenter.js'

// ESLint flat config requires plugin objects to be referentially identical
// across config blocks — every block shares this instance.
/** @type {any} */
export const arch = {
  meta: { name: '@edumapper/nuxt-harness' },
  rules: {
    'client-only-needs-reason': clientOnlyNeedsReason,
    'max-boolean-props': maxBooleanProps,
    'max-condition-operands': maxConditionOperands,
    'max-watchers': maxWatchers,
    'no-auth-gate-outside-middleware': noAuthGateOutsideMiddleware,
    'no-bare-navigate': noBareNavigate,
    'no-data-calls-in-operator': noDataCallsInOperator,
    'no-figma-asset-url': noFigmaAssetUrl,
    'no-hardcoded-color': noHardcodedColor,
    'no-nested-border-box': noNestedBorderBox,
    'no-off-palette-color-class': noOffPaletteColorClass,
    'no-presenter-in-page': noPresenterInPage,
    'no-provide-inject': noProvideInject,
    'no-smart-calls': noSmartCallsInPresenter,
    'no-server-ui-import': noServerUiImport,
    'no-reverse-layer': noReverseLayerImport,
    'no-reserved-item-value': noReservedItemValue,
    'no-nondeterministic-key': noNondeterministicKey,
    'use-fetch-needs-key': useFetchNeedsKey,
    'no-locale-format-in-render': noLocaleFormatInRender,
    'no-browser-api-in-setup': noBrowserApiInSetup,
    'timer-needs-scope-dispose': timerNeedsScopeDispose,
    'no-module-mutable-state': noModuleMutableState
  }
}

/** @typedef {import('./config.js').HarnessOptions} HarnessOptions */

const EVENT_BUS = {
  paths: ['mitt', 'tiny-emitter', 'eventemitter3', 'events'].map(name => ({
    name,
    message: '❌ Event bus. 💡 Hidden, untyped coupling across the tree. 🛠 Props down / emits up, or a composable with shared state.'
  }))
}

/** @param {{ group: string[], message: string }[]} patterns */
function restrictedImports(patterns) {
  return ['error', {
    ...EVENT_BUS,
    patterns: patterns.map(p => ({ ...p, allowTypeImports: true }))
  }]
}

const TEST_FILES = ['**/*.{test,spec}.{ts,js}']

const NAVIGATE_LITERAL = {
  selector: 'CallExpression[callee.name=\'navigateTo\'] > Literal.arguments:first-child[value=/^\\//]',
  message: '❌ navigateTo(\'/…\') string path. 💡 Bypasses i18n locale prefixes. 🛠 navigateTo(localePath({ name: \'…\' })).'
}
const NAVIGATE_TEMPLATE = {
  selector: 'CallExpression[callee.name=\'navigateTo\'] > TemplateLiteral.arguments:first-child[quasis.0.value.raw=/^\\//]',
  message: NAVIGATE_LITERAL.message
}

/**
 * Rule blocks — no parser/plugin definitions besides `arch`.
 * @param {HarnessOptions} [options]
 * @returns {import('eslint').Linter.Config[]}
 */
export function harness(options) {
  const o = resolveOptions(options)
  /** @param {string} glob */
  const app = glob => appGlobs(o.srcDir, glob)
  const server = rootGlobs('server', '**/*.{ts,js}')
  const shared = rootGlobs('shared', '**/*.{ts,js}')
  const appCode = app('**/*.{vue,ts,js}')
  const appSide = [...appCode, ...rootGlobs('modules', '**/*.{vue,ts,js}')]
  const appVue = [...app('**/*.vue'), ...rootGlobs('modules', '**/*.vue')]
  const components = app('components/**/*.vue')

  return [
    // ── Control flow & complexity ────────────────────────────────────────────
    {
      name: 'nuxt-harness/base',
      files: [...appCode, ...server, ...shared, ...rootGlobs('modules', '**/*.{vue,ts,js}')],
      plugins: { arch },
      rules: {
        // A control-flow statement in finally silently discards the in-flight throw/return.
        'no-unsafe-finally': 'error',
        // `catch (e) {}` swallows errors — re-throw, log, or comment why silence is intended.
        'no-empty': ['error', { allowEmptyCatch: false }],
        // Cyclomatic complexity: the C in CRAP. Above this, split the function.
        'complexity': ['error', 20],
        // Long positional parameter lists are the cheapest SRP smell to detect.
        'max-params': ['error', 4],
        '@typescript-eslint/no-explicit-any': 'error',
        'arch/no-figma-asset-url': 'error',
        // ── Guards: early return for real states, named compound conditions ──
        // Exit early instead of else/else-if after a return.
        'no-else-return': ['error', { allowElseIf: false }],
        // Deep nesting is the shape of missing early returns.
        'max-depth': ['error', 2],
        // A guard with 3+ operands has a meaning — name it (computed / function).
        'arch/max-condition-operands': 'error'
      }
    },
    {
      // Test helpers mirror the signatures they exercise; table-driven tests branch on purpose.
      name: 'nuxt-harness/tests',
      files: TEST_FILES,
      rules: { 'complexity': 'off', 'max-params': 'off' }
    },

    // ── Vue: type-based contracts ────────────────────────────────────────────
    {
      name: 'nuxt-harness/vue-contracts',
      files: appVue,
      rules: {
        'vue/define-props-declaration': ['error', 'type-based'],
        'vue/define-emits-declaration': ['error', 'type-based'],
        'vue/require-typed-ref': 'error',
        'vue/no-setup-props-reactivity-loss': 'error',
        // Dropping SSR must be a written decision, not a hydration-warning silencer.
        'arch/client-only-needs-reason': 'error'
      }
    },

    // ── Locality: import boundaries between app / server / shared ────────────
    {
      name: 'nuxt-harness/locality-app',
      files: appCode,
      rules: {
        '@typescript-eslint/no-restricted-imports': restrictedImports([{
          group: ['~~/server/**', ...o.allowServerImportsInApp.map(g => `!${g}`)],
          message: '❌ app/ imports server code. 💡 Server modules pull DB access and secrets into the client bundle. 🛠 Move the schema or type to shared/ and import it from #shared.'
        }]),
        ...(o.i18n ? { 'no-restricted-syntax': ['error', NAVIGATE_LITERAL, NAVIGATE_TEMPLATE] } : {}),
        'arch/no-bare-navigate': 'error',
        // Untyped, invisible dependencies — props down or a shared composable instead.
        'arch/no-provide-inject': 'error',
        // Watchers are hidden control flow; most are a computed or an event handler.
        'arch/max-watchers': 'error'
      }
    },
    {
      name: 'nuxt-harness/locality-ui',
      files: [...components, ...app('pages/**/*.vue'), ...app('layouts/**/*.vue')],
      rules: {
        // Access policy lives in middleware, not in what it protects.
        'arch/no-auth-gate-outside-middleware': ['error', { composables: o.authComposables }]
      }
    },
    {
      name: 'nuxt-harness/locality-server',
      files: server,
      rules: {
        '@typescript-eslint/no-restricted-imports': restrictedImports([{
          group: ['~/**', '@/**', '~~/app/**', '#app', '#components'],
          message: '❌ server/ imports app code. 💡 Couples the server bundle to the Vue runtime. 🛠 Move the logic to shared/ or server/utils/.'
        }]),
        'arch/no-server-ui-import': 'error'
      }
    },
    {
      name: 'nuxt-harness/locality-shared',
      files: shared,
      rules: {
        '@typescript-eslint/no-restricted-imports': restrictedImports([{
          group: ['~/**', '@/**', '~~/app/**', '~~/server/**', '#app', '#components'],
          message: '❌ shared/ imports app or server code. 💡 shared/ must stay isomorphic and dependency-free. 🛠 Move the code into shared/ or invert the dependency.'
        }])
      }
    },

    // ── Architecture: the 5-layer model (R0–R4) ──────────────────────────────
    {
      name: 'nuxt-harness/layer-pages',
      files: app('pages/**/*.vue'),
      rules: { 'arch/no-presenter-in-page': 'error' }
    },
    {
      name: 'nuxt-harness/layer-presenters',
      files: components,
      ignores: [...app('components/**/Orc*.vue'), ...app('components/**/Op*.vue')],
      rules: {
        'arch/no-smart-calls': ['error', { dataComposables: o.dataComposables }],
        'arch/no-reverse-layer': 'error'
      }
    },
    {
      name: 'nuxt-harness/layer-operators',
      files: app('components/**/Op*.vue'),
      rules: {
        'arch/no-reverse-layer': 'error',
        'arch/no-data-calls-in-operator': 'error'
      }
    },
    {
      name: 'nuxt-harness/illegal-states',
      files: components,
      rules: { 'arch/max-boolean-props': 'error' }
    },

    // ── SSR determinism: what a static gate can still decide ─────────────────
    // Render-path rules: only app-side code renders. Tests are excluded throughout: they mock at
    // module scope and drive fake timers on purpose, and none of it runs in SSR.
    {
      name: 'nuxt-harness/ssr-determinism',
      files: appSide,
      ignores: TEST_FILES,
      rules: {
        // The empty string is reserved by select-like components; it throws while hydrating.
        'arch/no-reserved-item-value': 'error',
        // A key the client cannot reproduce misses the payload cache and refetches.
        'arch/no-nondeterministic-key': 'error',
        // Locale formatting differs between Node and the browser inside the render path.
        'arch/no-locale-format-in-render': 'error',
        // Setup runs on the server: a top-level browser read throws or mismatches.
        'arch/no-browser-api-in-setup': 'error',
        // Parameterised requests need a key so hydration replays the right entry.
        'arch/use-fetch-needs-key': 'warn'
      }
    },
    {
      // A timer without scope-aware cleanup outlives the component. A plugin and a declared client
      // singleton live as long as the app, so an app-lifetime listener there is the point.
      name: 'nuxt-harness/ssr-timers',
      files: appSide,
      ignores: [...TEST_FILES, ...app('plugins/**'), ...o.clientSingletons],
      rules: { 'arch/timer-needs-scope-dispose': 'warn' }
    },
    {
      // Request data must not live in module scope (one instance per process), app or server side.
      name: 'nuxt-harness/ssr-module-state',
      files: [...appSide, ...server, ...shared],
      ignores: [...TEST_FILES, ...o.clientSingletons],
      rules: { 'arch/no-module-mutable-state': 'error' }
    },

    // ── Design system: opt-in, configured by the app ─────────────────────────
    ...designSystem(o, app('**/*.vue'))
  ]
}

/**
 * @param {import('./config.js').ResolvedOptions} o
 * @param {string[]} files
 * @returns {import('eslint').Linter.Config[]}
 */
function designSystem(o, files) {
  const ds = o.designSystem
  if (!ds) return []
  /** @type {import('eslint').Linter.RulesRecord} */
  const rules = {}
  if (ds.hardcodedColors) rules['arch/no-hardcoded-color'] = 'error'
  if (ds.palettes) rules['arch/no-off-palette-color-class'] = ['error', { palettes: ds.palettes }]
  if (ds.nestedBorderBox) rules['arch/no-nested-border-box'] = ['warn', { surfaceComponents: ds.surfaceComponents }]
  return [{ name: 'nuxt-harness/design-system', files, rules }]
}

/**
 * Rules that need type information (`parserOptions.projectService`). Full gate only.
 * @param {string} [tsconfigRootDir]
 * @param {HarnessOptions} [options]
 * @returns {import('eslint').Linter.Config[]}
 */
export function typeAware(tsconfigRootDir = process.cwd(), options = {}) {
  const { srcDir } = resolveOptions({ root: tsconfigRootDir, ...options })
  return [{
    name: 'nuxt-harness/type-aware',
    files: [...appGlobs(srcDir, '**/*.{vue,ts}'), ...rootGlobs('server', '**/*.ts'), ...rootGlobs('shared', '**/*.ts')],
    // Nuxt's root tsconfig is solution-style (references into .nuxt/); the project
    // service resolves each file to the referenced project that owns it.
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
    rules: {
      // Adding a union member must break every switch that forgot it.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // A condition the types prove constant is either dead code or a lying type.
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // A cast the types already satisfy hides the real type from the next reader.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error'
    }
  }]
}

/**
 * Self-contained config for `nuxt-harness fast`: no `.nuxt/`, no app node_modules.
 * Resolves parsers/plugins from the harness package's own dependencies.
 * @param {HarnessOptions} [options]
 * @returns {Promise<import('eslint').Linter.Config[]>}
 */
export async function standalone(options) {
  const [{ default: vue }, { default: vueParser }, { default: tsPlugin }, { default: tsParser }] = await Promise.all([
    import('eslint-plugin-vue'),
    import('vue-eslint-parser'),
    import('@typescript-eslint/eslint-plugin'),
    import('@typescript-eslint/parser')
  ])
  return [
    { ignores: ['**/node_modules/**', '**/.nuxt/**', '**/.output/**', '**/dist/**', '**/*.d.ts'] },
    {
      files: ['**/*.{ts,js}'],
      languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' }
    },
    {
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module', extraFileExtensions: ['.vue'] }
      }
    },
    // Keep the problem reports even when a file carries a disable comment —
    // escape hatches are reported separately by the static checks.
    // Disable comments for rules outside the harness set would otherwise be reported as unused.
    { linterOptions: { reportUnusedDisableDirectives: 'off' } },
    { plugins: { 'vue': vue, '@typescript-eslint': tsPlugin, arch } },
    ...harness(options)
  ]
}
