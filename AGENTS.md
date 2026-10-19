# nuxt-harness — agent guide

You are working in a Nuxt 4 app. This repository is the **harness**: a deterministic gate plus an
opinionated 5-layer architecture. It exists so that a changed file is checked in about a second, and
so that "done" means *checked*, not *claimed*.

Read this file, then run the loop in §2. Everything below is a command you can copy.

## 1. Install (once per app)

```bash
# published package
pnpm add -D @edumapper/nuxt-harness

# or this fork (SSR-determinism rules + runtime assertions)
pnpm add -D github:gabrielstuff/nuxt-harness#agent-hardening

# or try it with nothing installed
npx --package github:gabrielstuff/nuxt-harness#agent-hardening nuxt-harness fast --all
```

```js
// eslint.config.mjs
import { harness, typeAware } from '@edumapper/nuxt-harness/eslint'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(...harness(), ...typeAware(import.meta.dirname))
```

```jsonc
// package.json
{ "scripts": { "check": "nuxt-harness full", "check:fast": "nuxt-harness fast" } }
```

Add `.harness/` to `.gitignore`. Point the agent at the skill in
[`skills/nuxt-harness/SKILL.md`](skills/nuxt-harness/SKILL.md) for the architecture model and the
per-rule documentation in [`skills/nuxt-harness/references/eslint-rules.md`](skills/nuxt-harness/references/eslint-rules.md).

## 2. The loop you must follow

| when | command | needs |
|---|---|---|
| after every edit | `pnpm check:fast` (or `nuxt-harness fast <file>`) | nothing: ~1 s, no app install |
| before you say "done" | `pnpm check` (`nuxt-harness full`) | the app installed |
| on your own machine, when a page changed | `nuxt-harness assert --routes=/ …` | a browser (§4) |

Rules of the loop:

1. **Fix every error. Do not suppress.** `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, blanket
   `eslint-disable`, and any `eslint-disable` of a harness rule fail the gate.
2. **Do not rewrite a baseline** (`nuxt-harness-baseline.json`, `eslint-suppressions.json`) to absorb
   a violation you just introduced. Those files only shrink.
3. **A skipped check is not a pass.** The report lists a status per check: `pass`, `fail`, `skip`.
   A `skip` prints its reason. If the project declares a check required (`--require=<name>` or
   `assert.required: true`), a skip fails the gate.
4. **Read `.harness/report.json`, not this file, for the current result.** It is machine-readable:
   `{ files, passed, errors, warnings, checks: [{ name, status, note?, findings: [{ file, line, rule, message, severity }] }] }`.

## 3. What each command covers

| check | fast | full |
|---|---|---|
| import hygiene, escape hatches, console, secrets, unvalidated `readBody`, i18n keys, TODO | ✓ | ✓ |
| harness ESLint rules: layers, locality, guards, Vue contracts, complexity, SSR determinism, design system (opt-in) | ✓ | ✓ |
| `nuxt typecheck`, the app's type-aware ESLint, knip, cspell, jscpd, vitest + coverage | | ✓ |
| CRAP ≤ 30 per `.ts` function | | ✓ |
| runtime assertions (opens a browser) | | **local only, `--with-assert`** |

`full` needs the app installed: `nuxt typecheck` always runs, the type-aware ESLint step needs an
`eslint` in the app (`pnpm add -D @nuxt/eslint`), and knip/cspell/jscpd/vitest run only when their
config file exists. A `SKIP (reason)` line is the gate stating what it did not check — not a failure.

## 4. Runtime assertions are local-only

```bash
# local: opens each route in a pinned Chrome and asserts five invariants
NUXT_HARNESS_BASE_URL=http://localhost:3000 \
  nuxt-harness assert --routes=/,/?q=infirmiere --expect-404=/item/nope --marker='Résultats'

# force it in CI (explicit opt-in, needs a browser in the runner)
nuxt-harness assert --routes=/ --marker='Résultats' --allow-ci
```

- Invariants, each exact: HTTP status · marker present in the server HTML · marker **still** present
  after hydration · zero console errors (opt-in, `assert.console: true`) · viewport overflow (only
  when a CDP-capable runner measured it — never invented).
- No timing budget, no retry: run it twice, get the same findings.
- It **refuses to run when `CI` is set** unless `--allow-ci` is passed. A missing browser is a visible
  `skip`, never a pass.
- Config lives in `nuxt-harness.config.mjs` under `assert` (see
  [`docs/ci.md`](docs/ci.md) and [`skills/nuxt-harness/references/configuration.md`](skills/nuxt-harness/references/configuration.md)).

## 5. CI that works online

Use [`examples/ci/nuxt-harness.yml`](examples/ci/nuxt-harness.yml) — copy it to
`.github/workflows/`. The three details that make it work in a runner:

1. `actions/checkout` with **`fetch-depth: 0`** — `fast` diffs against the base branch, and a shallow
   clone has no `origin/HEAD`.
2. `NUXT_HARNESS_BASE=origin/${{ github.base_ref || github.event.repository.default_branch }}` —
   without a base the gate selects 0 files and **fails on purpose** (`harness/no-files`): a gate that
   reads nothing must not be green.
3. `nuxt-harness full` for the gate, plus `--allow-empty` only on jobs where an empty changeset is
   legitimate (docs-only PRs).

Full explanation and the verified recipe: [`docs/ci.md`](docs/ci.md).

## 6. Architecture in one table

| file | layer | data access | stores | navigation |
|---|---|---|---|---|
| `app/pages/**/*.vue` | Page — assembles Orc/Op | — | read | ✓ |
| `app/components/**/Orc*.vue` | Orchestrator — the feature's brain | via composables | ✓ | ✓ |
| `app/components/**/Op*.vue` | Operator — wires Presenters | composables only | ✓ | ✓ |
| `app/components/**/*.vue` | Presenter — props in, events out | ✕ | ✕ | ✕ |
| `app/composables/use*.ts` | Composable — reusable logic | ✓ | ✓ | — |

## 7. Working on the harness itself

```bash
bun install
bun run test        # rule fixtures + gate behaviour + docs examples
```

- One rule per file in `src/rules/`, registered in `src/eslint.js`.
- Every rule needs **positive and negative fixtures** in `test/`. A rule with only a positive fixture
  is a liability: it will fire on correct code in production.
- Message format: `❌ what → 💡 why → 🛠 fix → 📖 doc`, one array entry per line, joined with `\n`.
- Rules that inspect templates must use `context.sourceCode.parserServices.defineTemplateBodyVisitor`.
- Static file scans live in `src/checks.js`; the rule catalogue is
  `skills/nuxt-harness/references/eslint-rules.md` (add an anchor for each new rule).
