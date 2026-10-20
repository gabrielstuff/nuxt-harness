# Configuration

The harness works with no configuration on a standard Nuxt 4 app. Options exist for the parts
that depend on the app's stack: i18n, auth, the data layer, and the design system.

## Where options live

Put them in `nuxt-harness.config.mjs` (or `.js` / `.json`) at the repository root. `nuxt-harness
fast|full|hook|stop` read it automatically. Pass the same object to `harness()` so `eslint .`
agrees with the gate:

```js
// nuxt-harness.config.mjs
/** @type {import('@edumapper/nuxt-harness/eslint').HarnessOptions} */
export default {
  dataComposables: ['useApiQuery']
}
```

```js
// eslint.config.mjs
import { harness, typeAware } from '@edumapper/nuxt-harness/eslint'
import withNuxt from './.nuxt/eslint.config.mjs'
import harnessConfig from './nuxt-harness.config.mjs'

export default withNuxt(...harness(harnessConfig), ...typeAware(import.meta.dirname, harnessConfig))
```

Keep the config file free of runtime imports from the harness: `fast` can run through
`npx`/`bunx` without the app's `node_modules`. The `@type` comment is enough for editor hints.

## Options

| Option | Default | Effect |
|---|---|---|
| `srcDir` | `'app'` when `app/` exists, `'.'` when `pages/`/`components/` sit at the root | Where app-side code lives. Match your `nuxt.config` `srcDir`. |
| `i18n` | `true` when `@nuxtjs/i18n` is a dependency | Bans `navigateTo('/…')` string paths (use `localePath`). The i18n key check runs whenever a locale directory exists. |
| `authComposables` | `['useUserSession', 'useAuth', 'useSupabaseUser', 'useSupabaseSession']` | Composables whose value gates access. Checking one and redirecting is only allowed in middleware. |
| `dataComposables` | `[]` | Your own data-layer composables (`useApiQuery`, …). Presenters may not call them, like `useFetch`. |
| `bodyReaders` | `[]` | Your own request-body readers (e.g. a size-capped `readJsonBody`). Their result must be `.parse()`d, like `readBody`. |
| `allowServerImportsInApp` | `[]` | `~~/server/…` globs that `app/` may import, e.g. `['~~/server/utils/validators/**']`. Prefer moving such code to `shared/`. |
| `clientSingletons` | `[]` | Root-relative globs of modules that deliberately hold one browser-side instance for the app's lifetime, e.g. `['app/composables/useIsMobile.ts']`. Exempt from `no-module-mutable-state` and `timer-needs-scope-dispose`. Only list a module whose state is written exclusively in the browser (in `onMounted`, an event handler, or under `import.meta.client`), and say why next to the entry. |
| `designSystem` | `false` | Opt-in design-system rules. See below. |

## Design system

The harness ships no design tokens and enforces none by default. Turn the checks on once the
app has a design system, and give it your palettes:

```js
// nuxt-harness.config.mjs
export default {
  designSystem: {
    // Tailwind built-in palettes you allow. Others (gray, sky, …) are reported.
    // Custom palettes (brand, accent-*) are never reported. Omit to skip this check.
    palettes: ['zinc', 'red', 'green'],
    hardcodedColors: true,          // hex/rgb/hsl literals (default true)
    nestedBorderBox: true,          // warn on boxes inside bordered surfaces (default true)
    surfaceComponents: ['UCard', 'UModal', 'AppPanel'] // components that render a bordered surface
  }
}
```

`designSystem: {}` enables the hardcoded-color and nested-box checks without a palette.

A team that ships its tokens as a package can export a harness preset from it:

```js
// nuxt-harness.config.mjs
import { harnessDesignSystem } from '@acme/design-tokens/harness'

export default { designSystem: harnessDesignSystem }
```

If `fast` runs without the app's `node_modules` (`npx`/`bunx`), keep such imports out of the
config file, or run the installed binary instead (`node_modules/.bin/nuxt-harness`).

## Turning a rule off

Prefer fixing the code. For legacy code, record existing violations once —
`eslint . --suppress-all` for ESLint rules, `nuxt-harness full --update-baseline` for the static
checks and CRAP — and the gate then fails only on new ones. To drop a rule entirely, add a
block after `harness()` in `eslint.config.mjs`. `nuxt-harness fast` uses its own config, so a
rule turned off only in `eslint.config.mjs` still reports there: suppressions are the supported
escape hatch for both.
