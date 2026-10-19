# CI that works online

Copy [`examples/ci/nuxt-harness.yml`](../examples/ci/nuxt-harness.yml) to
`.github/workflows/nuxt-harness.yml` and adjust the package manager. This page explains why each
line is there, and what breaks without it.

## The two details that decide success

| detail | why | symptom when missing |
|---|---|---|
| `actions/checkout` with `fetch-depth: 0` | `fast` selects *changed* files by diffing against the base branch; a shallow clone has no `origin/HEAD` and no merge base | the gate selects 0 files and **fails on purpose** with `harness/no-files` |
| `NUXT_HARNESS_BASE=origin/${{ github.base_ref \|\| github.event.repository.default_branch }}` | names the ref to diff against on PRs and on pushes | same as above: 0 files, exit 1 |

The failure is deliberate. A gate that reads no file must not report success — that is how a green
build hides a broken app. If a job can legitimately have an empty changeset (a docs-only PR), say so
explicitly with `--allow-empty`.

Verified locally with a scratch repository that has no `origin/HEAD`:

```
$ CI=true nuxt-harness fast                      # no base, no file arguments
✗ failed  (harness/no-files: nothing to check — 0 files selected)          exit 1
$ CI=true nuxt-harness fast --allow-empty        # explicit
✓ passed                                                                  exit 0
$ CI=true NUXT_HARNESS_BASE=main nuxt-harness fast   # changed file on a branch
✗ 4 errors in 1525ms  (real findings on the changed file)                 exit 1
```

## What to run

```bash
pnpm exec nuxt-harness fast --allow-empty   # ~1 s: static checks + harness ESLint rules on changed files
pnpm exec nuxt-harness full                 # every file + the app's toolchain + CRAP
```

`full` runs the optional tools only when the app has configured them: `nuxt typecheck` always, plus
type-aware ESLint, and knip, cspell, jscpd and vitest + coverage when `knip.json`, `cspell.json`,
`.jscpd.json` or `vitest.config.*` exist. CRAP ≤ 30 per `.ts` function needs vitest coverage.

Always upload `.harness/report.json` (`if: always()`). It is the machine-readable record of what ran:

```json
{ "files": 12, "passed": false, "errors": 3, "warnings": 1,
  "checks": [{ "name": "ESLint (harness rules)", "status": "fail", "durationMs": 940,
               "findings": [{ "file": "app/pages/index.vue", "line": 37, "rule": "arch/no-reserved-item-value",
                              "severity": "error", "message": "❌ value: '' …" }] }] }
```

`status` is `pass`, `fail` or `skip`, and a `skip` carries a `note` with the reason. A skipped check
is visible in the log and in the report; it fails the job only when the project declares it required
(`--require=<check name>`, or `assert.required: true`).

## Runtime assertions in CI (optional, opt-in)

`nuxt-harness assert` opens the app in a browser. It is **local-only by default**: it does not run in
`fast`, it does not run in `full` without `--with-assert`, and it refuses to run when `CI` is set
unless `--allow-ci` is explicit. That is a product decision: no browser dependency in CI, and no
silent skip either — CI prints

```
→ Runtime assertions.............. SKIP (local-only: CI detected (pass --allow-ci to override))
```

If a team wants the browser check in CI, the second job in the example workflow shows the complete
recipe: build the app, start it, install Chrome (`browser-actions/setup-chrome`), export
`NUXT_HARNESS_CHROME` and `NUXT_HARNESS_BASE_URL`, then run `assert --allow-ci`. Keep it opt-in
(`vars.RUN_RUNTIME_ASSERTIONS == 'true'`) so the default pipeline stays fast and hermetic.

## What `full` needs from the app

Observed on a real Nuxt 4 app (8.4 s total):

| step | result when the app is plain | what to add |
|---|---|---|
| `TypeScript (nuxt typecheck)` | PASS 6.8 s | nothing |
| `ESLint (project, type-aware)` | **FAIL**: `package.json eslint not installed` | `@nuxt/eslint` (it brings ESLint, `eslint-plugin-vue`, `vue-eslint-parser`, `@typescript-eslint/*`) |
| `Dead code (knip)` / `Spelling (cspell)` / `Duplicates (jscpd)` / `Tests (vitest)` | `SKIP (no knip.json)` … | the matching config file, or ignore |
| `CRAP (complexity × coverage)` | FAIL with real scores; every function counts as 0 % covered without tests | a `vitest.config.*` with coverage enabled |
| `Runtime assertions` | `SKIP (local-only: pass --with-assert to run it here)` | nothing: this is the intended CI behaviour |

The skipped lines are not failures. They are the gate telling you what it did **not** check, and why.

## Baselines and the ratchet

Legacy violations are recorded once, then may only go down:

```bash
npx eslint . --suppress-all                     # → eslint-suppressions.json
pnpm exec nuxt-harness full --update-baseline   # → nuxt-harness-baseline.json
```

Two rules for the agent, and one for CI:

1. Never `--update-baseline` to absorb a violation you just introduced.
2. Never add a suppression without a `-- reason`; suppressions of harness rules and blanket
   `eslint-disable` are rejected outright.
3. In CI, compare the baseline files against the base branch and fail when they grow. The base ref is
   already available as `NUXT_HARNESS_BASE`, so this is one `git diff --stat` step.

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `harness/no-files: nothing to check — 0 files selected` | no base ref and no file arguments | `fetch-depth: 0` + `NUXT_HARNESS_BASE`, or pass files, or `--allow-empty` |
| `Runtime assertions SKIP (local-only: CI detected)` | correct behaviour in CI | pass `--allow-ci` **and** install a browser, or leave it local |
| `SKIP (no Chrome found: set NUXT_HARNESS_CHROME)` | no browser on this machine | `NUXT_HARNESS_CHROME=/path/to/chrome` |
| `SKIP (no routes: set assert.routes or pass --routes)` | nothing to open | `--routes=/,/pricing` |
| `full` fails on `nuxt typecheck` after a fresh clone | `.nuxt` not generated yet | run `pnpm exec nuxt prepare` (or `postinstall`) before `full` |
| `full` fails on `ESLint (project, type-aware)` with `package.json eslint not installed` | the app has no ESLint dependency | `pnpm add -D @nuxt/eslint` and add the module |
| a rule fires in CI but not locally | the local tree has the file in `eslint-suppressions.json` | prune: `npx eslint . --prune-suppressions` |

## Requirements

Node ≥ 22, a git repository, Nuxt 4 (`app/` layout, or `srcDir: '.'`). The lint toolchain is a peer
dependency, so the harness uses the app's versions: ESLint `^9.24 || ^10`, `eslint-plugin-vue` `^10`,
`vue-eslint-parser` `^10`, `@typescript-eslint/*` `^8.12`.
