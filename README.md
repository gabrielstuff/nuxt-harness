# nuxt-harness

[![CI](https://github.com/edumapper/nuxt-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/edumapper/nuxt-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A deterministic quality gate for **Nuxt 4** apps, built for teams that ship code with AI agents.

- **Architecture rules**: a 5-layer component model (Page → Orchestrator → Operator → Presenter →
  Composable), enforced by ESLint, so smart components can't quietly grow into monoliths.
- **Guard and locality rules**: early returns, named conditions, `app` ↛ `server` imports,
  awaited `navigateTo`, auth gates in middleware, no `provide`/`inject`.
- **A gate the agent can't switch off**: `@ts-ignore` and `eslint-disable` of harness rules fail the gate.
- **Fast mode for agents**: lints changed files in ~1 s, without the app's `node_modules` or `.nuxt/`.
- **Claude Code hooks**: feedback after every edit, and a turn can't end while changed files fail.
- **Ratchets for legacy code**: existing violations are recorded once; the count can only go down.

Every finding explains itself: `❌ what → 💡 why → 🛠 fix → 📖 doc`.

```text
  @edumapper/nuxt-harness 0.6.0 — fast gate, 3 files

  → ESLint (harness rules).......... FAIL 412ms
    ✗ app/components/ProductCard.vue:4 [arch/no-smart-calls] ❌ useRouter() — navigation in a Presenter
      💡 A Presenter doesn't decide where to go. It emits an event,
         and the Operator (Op*.vue) or Orchestrator (Orc*.vue) decides what to do.
      🛠 Replace with: emit('select', item)
```

## This fork (`gabrielstuff/nuxt-harness`, branch `agent-hardening`)

Adds, on top of v0.6.0:

- **SSR-determinism rules**: `no-reserved-item-value` (the empty-string value a Reka-based select
  reserves — it throws while hydrating, invisible to typecheck and curl), `no-nondeterministic-key`,
  `use-fetch-needs-key`, `no-locale-format-in-render`, `no-browser-api-in-setup`,
  `no-module-mutable-state`, `timer-needs-scope-dispose`.
- **Runtime assertions** (`nuxt-harness assert`): opens the built app in a browser and asserts five
  invariants. **Local-only**: not in `fast`, not in `full` without `--with-assert`, and it refuses to
  run when `CI` is set unless `--allow-ci`.
- **An honest empty run**: selecting 0 files fails (`harness/no-files`) instead of reporting success,
  and `--all` walks the filesystem when there is no git repository.

```bash
pnpm add -D github:gabrielstuff/nuxt-harness#agent-hardening
```

Agents: start at [`AGENTS.md`](AGENTS.md). CI: [`docs/ci.md`](docs/ci.md) and
[`examples/ci/nuxt-harness.yml`](examples/ci/nuxt-harness.yml).

## Quick start

Try it on any Nuxt 4 repository, with nothing installed:

```bash
npx --package github:edumapper/nuxt-harness#v0.6.0 nuxt-harness fast --all
```

Then adopt it:

```bash
npm i -D github:edumapper/nuxt-harness#v0.6.0   # or pnpm / yarn / bun add -d
```

```js
// eslint.config.mjs (with @nuxt/eslint)
import { harness, typeAware } from '@edumapper/nuxt-harness/eslint'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(...harness(), ...typeAware(import.meta.dirname))
```

```jsonc
// package.json
{ "scripts": { "check": "nuxt-harness full", "check:fast": "nuxt-harness fast" } }
```

Add `.harness/` to `.gitignore`. On an existing app, record current violations once — after
that, the counts can only go down:

```bash
npx eslint . --suppress-all                  # → eslint-suppressions.json (read by eslint and `fast`)
npx nuxt-harness full --update-baseline      # → nuxt-harness-baseline.json (static checks + CRAP)
```

Requirements: Node ≥ 22, a git repository, Nuxt 4 (the `app/` layout, or `srcDir: '.'`).
Nuxt layers under `layers/` are covered too.

The lint toolchain is a peer dependency, so the harness uses your project's versions and never
installs its own copies: ESLint `^9.24 || ^10`, `eslint-plugin-vue` `^10`, `vue-eslint-parser`
`^10` and `@typescript-eslint/*` `^8.12`. `@nuxt/eslint` already brings them; otherwise npm,
pnpm and bun install the missing peers for you (the no-install `npx`/`bunx` mode included).

## Commands

```bash
nuxt-harness fast [files…] [--all] [--json]    # changed files (vs origin/HEAD merge-base + untracked)
nuxt-harness full [--update-baseline] [--json] # every file + the app's toolchain; needs the app installed
nuxt-harness hook                              # Claude Code PostToolUse: gate the edited file
nuxt-harness stop                              # Claude Code Stop: the turn can't end while changed files fail
```

| Check | fast | full |
|---|---|---|
| Import hygiene, escape hatches, console, secrets, unvalidated `readBody`, i18n keys, TODO (warn) | ✓ | ✓ |
| Harness ESLint rules (layers, locality, guards, Vue contracts, complexity, opt-in design system) | ✓ | ✓ |
| `nuxt typecheck`, the app's ESLint config (type-aware), knip, cspell, jscpd, vitest + coverage | | ✓ |
| CRAP ≤ 30 per `.ts` function | | ✓ |

`full` runs the optional tools only when the app has configured them (`knip.json`,
`cspell.json`, `.jscpd.json`, `vitest.config.*`), through the app's package manager. Both
commands write `.harness/report.json` for agents and CI. Set `NUXT_HARNESS_BASE` to compare
`fast` against another branch than `origin/HEAD`.

## Configuration

None is required. Options cover what depends on your stack — put them in
`nuxt-harness.config.mjs` at the repo root:

```js
/** @type {import('@edumapper/nuxt-harness/eslint').HarnessOptions} */
export default {
  i18n: true,                          // default: on when @nuxtjs/i18n is installed
  authComposables: ['useUserSession'], // checking these + redirecting belongs in middleware
  dataComposables: ['useApiQuery'],    // your data-layer wrappers, banned in Presenters
  designSystem: {                      // opt-in; the harness ships no design tokens
    palettes: ['zinc', 'red', 'green']
  }
}
```

The design-system rules (hardcoded colors, allowed Tailwind palettes, nested bordered boxes)
are **off** until you enable them. See [configuration](skills/nuxt-harness/references/configuration.md)
for every option and how to share tokens from a package.

## Claude Code

```jsonc
// .claude/settings.json
{
  "hooks": {
    // after each edit: feedback lands before the agent moves on
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit", "hooks": [
      { "type": "command", "command": "node_modules/.bin/nuxt-harness hook", "timeout": 60 }
    ] }],
    // end of turn: every file changed on the branch (Bash edits included) must pass;
    // blocks at most 3 times in a row per session, then warns the user instead
    "Stop": [{ "hooks": [
      { "type": "command", "command": "node_modules/.bin/nuxt-harness stop", "timeout": 120 }
    ] }]
  }
}
```

The package ships an agent skill in [`skills/nuxt-harness/`](skills/nuxt-harness/SKILL.md): the
architecture, the rules, and lint-clean reference implementations of each layer. Link it from
`node_modules/@edumapper/nuxt-harness/skills/nuxt-harness` into `.claude/skills/` (or your
agent's skills directory) so it always matches the installed version.

Other agents can use the same gate: run `nuxt-harness fast` after each edit and read
`.harness/report.json`.

## The architecture in one table

| File | Layer | Data access | Stores | Navigation |
|---|---|---|---|---|
| `app/pages/**/*.vue` | Page — assembles Orc/Op | — | read | ✓ |
| `app/components/**/Orc*.vue` | Orchestrator — the feature's brain | via composables | ✓ | ✓ |
| `app/components/**/Op*.vue` | Operator — wires Presenters | composables only | ✓ | ✓ |
| `app/components/**/*.vue` | Presenter — props in, events out | ✕ | ✕ | ✕ |
| `app/composables/use*.ts` | Composable — reusable logic | ✓ | ✓ | — |

- [Architecture](skills/nuxt-harness/references/architecture.md): the model, its rules and an audit method
- [Rules](skills/nuxt-harness/references/eslint-rules.md): every rule and why it exists
- [Gold standards](skills/nuxt-harness/references/gold-standards.md): reference code for each layer
- [Example app](examples/basic): a minimal Nuxt 4 app that passes the gate

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The source is
plain ESM JavaScript with JSDoc types: no build step.

```bash
bun install
bun run test
```

## License

[MIT](LICENSE)
