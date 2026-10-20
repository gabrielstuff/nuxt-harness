// @ts-check
/**
 * Harness options: defaults, auto-detection, and the optional config file.
 *
 * The same options feed both entry points:
 *   - the app's `eslint.config.mjs` → `harness(options)`
 *   - `nuxt-harness fast|full`     → reads `nuxt-harness.config.{mjs,js,json}` at the repo root
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @typedef {object} DesignSystemOptions
 * @property {string[]} [palettes] Tailwind color palettes the app allows (e.g. `['zinc', 'brand', 'red']`).
 *   Built-in Tailwind palettes not listed here are reported. Omit to skip the palette check.
 * @property {boolean} [hardcodedColors] Report hex/rgb/hsl literals in templates and scripts. Default `true`.
 * @property {boolean} [nestedBorderBox] Warn on bordered, rounded boxes nested in other bordered surfaces. Default `true`.
 * @property {string[]} [surfaceComponents] Components that always render a bordered surface. Default: Nuxt UI overlays and cards.
 *
 * @typedef {object} HarnessOptions
 * @property {string} [root] Project root used for auto-detection. Default `process.cwd()`.
 * @property {'app' | '.'} [srcDir] Nuxt `srcDir`. Default: `app` when `app/` exists (Nuxt 4), otherwise `.`.
 * @property {boolean} [i18n] Enforce localized navigation and check `t('…')` keys. Default: on when `@nuxtjs/i18n` is a dependency.
 * @property {string[]} [authComposables] Composables whose value gates access; checking them + redirecting is only allowed in middleware.
 * @property {string[]} [dataComposables] The app's own data-layer composables, treated like `useFetch` in Presenters.
 * @property {string[]} [bodyReaders] The app's own request-body readers (e.g. a size-capped `readJsonBody`), checked like `readBody`.
 * @property {string[]} [allowServerImportsInApp] `~~/server/…` globs that `app/` may import (e.g. shared validators).
 * @property {string[]} [clientSingletons] Root-relative globs of modules that deliberately hold one browser-side instance for the app's lifetime (written only in the browser). Exempt from `no-module-mutable-state` and `timer-needs-scope-dispose`.
 * @property {false | DesignSystemOptions} [designSystem] Opt-in design-system rules. Default `false`.
 * @property {AssertOptions} [assert] Local-only runtime assertions (opens a browser). Never runs in CI unless `--allow-ci`.
 */

/**
 * @typedef {object} AssertOptions
 * @property {string[]} [routes] Routes to open, e.g. `['/', '/?q=x']`.
 * @property {string[]} [expect404] Routes that must answer 404 (soft-404 detector).
 * @property {string} [marker] Text the page must contain in the server HTML and after hydration.
 * @property {number} [width] Viewport width. Default 390.
 * @property {number} [height] Viewport height. Default 844.
 * @property {boolean} [console] Also assert zero console errors. Default false (Chrome build dependent).
 * @property {string} [chrome] Chrome binary. Defaults to `NUXT_HARNESS_CHROME`.
 * @property {boolean} [required] Fail the gate when the check cannot run. Default false.
 */

export const DEFAULT_AUTH_COMPOSABLES = ['useUserSession', 'useAuth', 'useSupabaseUser', 'useSupabaseSession']
export const DEFAULT_SURFACE_COMPONENTS = ['UCard', 'UModal', 'USlideover', 'UDrawer', 'UPopover', 'UAlert', 'UTooltip', 'UContextMenu', 'UDropdownMenu']
export const CONFIG_FILES = ['nuxt-harness.config.mjs', 'nuxt-harness.config.js', 'nuxt-harness.config.json']

/** @param {string} root @returns {Record<string, string>} */
function dependencies(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    return {} // no package.json: nothing to detect
  }
}

/**
 * Nuxt 4 puts app code in `app/`. A project that kept the Nuxt 3 layout (`srcDir: '.'`)
 * has `pages/` or `components/` at the root and no `app/` directory.
 * @param {string} root
 */
function detectSrcDir(root) {
  if (existsSync(join(root, 'app'))) return 'app'
  return ['pages', 'components', 'layouts'].some(d => existsSync(join(root, d))) ? '.' : 'app'
}

// ─── Source layout ──────────────────────────────────────────────────────────
// Every glob is also matched inside Nuxt layers (`layers/<name>/…`, auto-registered since Nuxt 3.12).
const LAYER_ROOTS = ['', 'layers/*/']
const APP_DIRS = ['components', 'composables', 'layouts', 'middleware', 'pages', 'plugins', 'utils']
const SERVER_SIDE_DIRS = ['server', 'shared', 'modules']

/**
 * Globs for app-side code. `glob` is relative to the srcDir: `'**\/*.vue'`, `'components/**\/Op*.vue'`.
 * @param {'app' | '.'} srcDir @param {string} glob
 */
export function appGlobs(srcDir, glob) {
  if (srcDir === 'app') return LAYER_ROOTS.map(r => `${r}app/${glob}`)
  if (!glob.startsWith('**/')) return LAYER_ROOTS.map(r => `${r}${glob}`)
  return LAYER_ROOTS.flatMap(r => [...APP_DIRS.map(d => `${r}${d}/${glob}`), `${r}{app,error}.vue`])
}

/** @param {'server' | 'shared' | 'modules'} dir @param {string} glob */
export const rootGlobs = (dir, glob) => LAYER_ROOTS.map(r => `${r}${dir}/${glob}`)

/** Files the gate owns, as a path test relative to the project root. @param {'app' | '.'} srcDir */
export function sourcePattern(srcDir) {
  const dirs = [...(srcDir === 'app' ? ['app'] : APP_DIRS), ...SERVER_SIDE_DIRS].join('|')
  const rootFiles = srcDir === 'app' ? '' : '|(?:app|error)\\.vue'
  return new RegExp(`^(?:layers/[^/]+/)?(?:(?:${dirs})/.+\\.(?:vue|ts|js|mjs)${rootFiles})$`)
}

/**
 * @typedef {Required<Omit<HarnessOptions, 'designSystem'>> & { designSystem: false | Required<Omit<DesignSystemOptions, 'palettes'>> & Pick<DesignSystemOptions, 'palettes'> }} ResolvedOptions
 * @param {HarnessOptions} [options]
 * @returns {ResolvedOptions}
 */
export function resolveOptions(options = {}) {
  const root = options.root ?? process.cwd()
  const deps = dependencies(root)
  const ds = options.designSystem
  return {
    root,
    srcDir: options.srcDir ?? detectSrcDir(root),
    i18n: options.i18n ?? ('@nuxtjs/i18n' in deps || existsSync(join(root, 'i18n', 'locales'))),
    authComposables: options.authComposables ?? DEFAULT_AUTH_COMPOSABLES,
    dataComposables: options.dataComposables ?? [],
    bodyReaders: options.bodyReaders ?? [],
    allowServerImportsInApp: options.allowServerImportsInApp ?? [],
    clientSingletons: options.clientSingletons ?? [],
    assert: {
      routes: options.assert?.routes ?? [],
      expect404: options.assert?.expect404 ?? [],
      marker: options.assert?.marker ?? '',
      width: options.assert?.width ?? 390,
      height: options.assert?.height ?? 844,
      console: options.assert?.console ?? false,
      chrome: options.assert?.chrome ?? '',
      required: options.assert?.required ?? false
    },
    designSystem: ds
      ? {
          palettes: ds.palettes,
          hardcodedColors: ds.hardcodedColors ?? true,
          nestedBorderBox: ds.nestedBorderBox ?? true,
          surfaceComponents: ds.surfaceComponents ?? DEFAULT_SURFACE_COMPONENTS
        }
      : false
  }
}

/**
 * Loads the first config file found at `root`, or `{}`.
 * @param {string} root
 * @returns {Promise<HarnessOptions>}
 */
export async function loadConfig(root) {
  const file = CONFIG_FILES.map(f => join(root, f)).find(existsSync)
  if (!file) return {}
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'))
  const mod = await import(pathToFileURL(file).href)
  return mod.default ?? {}
}
