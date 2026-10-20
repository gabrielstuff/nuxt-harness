import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig, resolveOptions, sourcePattern } from '../src/config.js'
import { harness, standalone, typeAware } from '../src/eslint.js'

let root: string | undefined

function project(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'nuxt-harness-config-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const rulesOf = (configs: ReturnType<typeof harness>) => Object.assign({}, ...configs.map(c => c.rules ?? {}))

describe('resolveOptions — sensible defaults for any Nuxt 4 app', () => {
  it('detects the Nuxt 4 app/ layout, and the Nuxt 3 layout kept with srcDir: "."', () => {
    expect(resolveOptions({ root: project({ 'app/app.vue': '' }) }).srcDir).toBe('app')
    expect(resolveOptions({ root: project({ 'pages/index.vue': '' }) }).srcDir).toBe('.')
  })

  it('turns i18n on only when @nuxtjs/i18n is installed', () => {
    expect(resolveOptions({ root: project({ 'package.json': '{}' }) }).i18n).toBe(false)
    expect(resolveOptions({ root: project({ 'package.json': '{"devDependencies":{"@nuxtjs/i18n":"10.0.0"}}' }) }).i18n).toBe(true)
  })
})

describe('design system — opt-in, no tokens shipped', () => {
  it('enables no design-system rule by default', () => {
    const rules = rulesOf(harness({ root: project({}) }))
    expect(Object.keys(rules).filter(r => /color|border-box/.test(r))).toEqual([])
  })

  it('enables the rules the app configures, with its own palettes', () => {
    const rules = rulesOf(harness({ root: project({}), designSystem: { palettes: ['zinc', 'brand'], nestedBorderBox: false } }))
    expect(rules['arch/no-hardcoded-color']).toBe('error')
    expect(rules['arch/no-off-palette-color-class']).toEqual(['error', { palettes: ['zinc', 'brand'] }])
    expect(rules['arch/no-nested-border-box']).toBeUndefined()
  })
})

describe('i18n — localized navigation only matters with @nuxtjs/i18n', () => {
  it('bans navigateTo(\'/…\') string paths only when i18n is on', () => {
    expect(rulesOf(harness({ root: project({}), i18n: false }))['no-restricted-syntax']).toBeUndefined()
    expect(rulesOf(harness({ root: project({}), i18n: true }))['no-restricted-syntax']).toBeDefined()
  })
})

describe('sourcePattern — files the gate owns', () => {
  it('covers app/server/shared/modules and Nuxt layers, nothing else', () => {
    const scope = sourcePattern('app')
    expect(['app/pages/a.vue', 'server/api/x.ts', 'shared/types.ts', 'layers/base/app/components/A.vue'].every(f => scope.test(f))).toBe(true)
    expect(['nuxt.config.ts', 'scripts/x.ts', 'pages/a.vue'].some(f => scope.test(f))).toBe(false)
  })

  it('follows srcDir "." for apps that kept the Nuxt 3 layout', () => {
    const scope = sourcePattern('.')
    expect(['pages/a.vue', 'components/A.vue', 'app.vue', 'server/api/x.ts'].every(f => scope.test(f))).toBe(true)
    expect(scope.test('nuxt.config.ts')).toBe(false)
  })
})

describe('loadConfig', () => {
  it('reads nuxt-harness.config.mjs, then .json, else {}', async () => {
    expect(await loadConfig(project({}))).toEqual({})
    expect(await loadConfig(project({ 'nuxt-harness.config.json': '{"i18n":true}' }))).toEqual({ i18n: true })
    expect(await loadConfig(project({ 'nuxt-harness.config.mjs': 'export default { dataComposables: [\'useApi\'] }' }))).toEqual({ dataComposables: ['useApi'] })
  })
})

// Rule options must exist in the lowest peer versions too (CI runs this suite on them):
// an unknown option makes ESLint reject the whole config.
describe('typeAware — runs with type information', () => {
  it('reports a non-exhaustive switch over a union', async () => {
    const cwd = project({
      'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true},"include":["app/**/*.ts"]}',
      'app/utils/status.ts': 'type Status = \'a\' | \'b\'\nexport function code(s: Status): number {\n  switch (s) {\n    case \'a\': return 1\n  }\n  return 0\n}\n'
    })
    const config = [...await standalone({ root: cwd }), ...typeAware(cwd, { root: cwd })]
    const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: config })
    const [result] = await eslint.lintFiles(['app/utils/status.ts'])
    expect(result?.messages.map(m => m.ruleId)).toEqual(['@typescript-eslint/switch-exhaustiveness-check'])
  })
})

// The SSR rules gate the render path. Tests, server code, plugins and declared client singletons
// are scoped out explicitly, each for its own reason: one finding should mean one real risk.
describe('SSR rules — scoped to the render path', () => {
  const lint = async (cwd: string, filePath: string, code: string, options = {}) => {
    const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: await standalone({ root: cwd, ...options }) })
    const [result] = await eslint.lintText(code, { filePath: join(cwd, filePath) })
    return (result?.messages ?? []).map(m => m.ruleId).filter(id => id?.startsWith('arch/')).sort()
  }
  const singleton = 'export const runs = ref([])\nexport function track () {\n  window.addEventListener(\'resize\', () => {})\n}\n'
  const listener = 'export default defineNuxtPlugin(() => {\n  window.addEventListener(\'beforeunload\', () => {})\n})\n'

  it('reports an app module, not its test file', async () => {
    const cwd = project({ 'app/app.vue': '' })
    expect(await lint(cwd, 'app/composables/useRuns.ts', singleton)).toEqual(['arch/no-module-mutable-state', 'arch/timer-needs-scope-dispose'])
    expect(await lint(cwd, 'app/composables/useRuns.test.ts', singleton)).toEqual([])
  })

  it('exempts a declared client singleton', async () => {
    const cwd = project({ 'app/app.vue': '' })
    expect(await lint(cwd, 'app/composables/useRuns.ts', singleton, { clientSingletons: ['app/composables/useRuns.ts'] })).toEqual([])
  })

  it('keeps server code to module state: no select items, no component scope', async () => {
    const cwd = project({ 'app/app.vue': '' })
    expect(await lint(cwd, 'server/utils/options.ts', 'export const items = [{ value: \'\' }]\nsetTimeout(() => {}, 10)\n')).toEqual([])
    expect(await lint(cwd, 'server/utils/session.ts', 'export const users = reactive({})\n')).toEqual(['arch/no-module-mutable-state'])
  })

  it('lets a plugin hold an app-lifetime listener, not a composable', async () => {
    const cwd = project({ 'app/app.vue': '' })
    expect(await lint(cwd, 'app/plugins/guard.client.ts', listener)).toEqual([])
    expect(await lint(cwd, 'app/composables/useGuard.ts', listener)).toEqual(['arch/timer-needs-scope-dispose'])
  })
})
