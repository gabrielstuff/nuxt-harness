---
name: nuxt-harness
description: Use when developing a Nuxt 4 / Vue 3 application guarded by @edumapper/nuxt-harness. It enforces a 5-layer component architecture (Page → Orchestrator → Operator → Presenter → Composable) with ESLint rules and a quality gate (`nuxt-harness fast` / `full`). Use when creating or reviewing components, composables or server routes, running quality checks, fixing gate findings, or auditing a Nuxt codebase for architectural violations.
---

# Nuxt Harness

Opinionated harness for Nuxt 4 / Vue 3: a strict 5-layer component architecture, enforced by
ESLint rules and a deterministic quality gate.

## Core principle

Build features by assembling simple, testable layers — never with monolithic smart components.
Each layer has clearly defined rights. ESLint enforces those rights, so every violation comes
with the reason and the fix.

---

## The 5-layer model

```
app/pages/**/*.vue          → Page         (assembler — no business logic, no direct Presenters)
app/components/**/Orc*.vue  → Orchestrator (smartest — data, stores, complex logic)
app/components/**/Op*.vue   → Operator     (smart, focused — wires Presenters together)
app/components/**/*.vue     → Presenter    (dumb — props in, events out, nothing else)
app/composables/use*.ts     → Composable   (reactive logic, reusable across layers)
```

**Data flow**: props flow down (Page → Orchestrator → Operator → Presenter), events bubble up.

See `references/architecture.md` for the full model, the 8 rules, the store access matrix and
the audit method.

---

## Naming convention → rights

| File pattern | Layer | Data access? | Stores? | Navigate? |
|---|---|---|---|---|
| `pages/**/*.vue` | Page | No | Read only | Yes |
| `components/**/Orc*.vue` | Orchestrator | Through domain composables | Yes | Yes |
| `components/**/Op*.vue` | Operator | Domain composables only, no raw `$fetch`/`useFetch` | Yes | Yes |
| `components/**/*.vue` | Presenter | No | No | No |
| `composables/use*.ts` | Composable | Yes | Yes | — |

The file prefix decides what ESLint allows. No discipline required — the gate fails.

---

## The gate — run it, never suppress it

| Command | When | What | Needs |
|---|---|---|---|
| `nuxt-harness fast` | after every edit — hooks run it on the edited file, and on every changed file before a turn ends | static checks + harness ESLint rules on changed files (~1 s) | nothing: no app `node_modules`, no `.nuxt/` |
| `nuxt-harness full` | before declaring done, and in CI | fast checks on every file + `nuxt typecheck`, type-aware ESLint, knip, cspell, jscpd, vitest + CRAP (the tools the app has configured) | the app installed |

Both print `❌ what → 💡 why → 🛠 fix → 📖 doc` findings and write `.harness/report.json`
(`--json` prints it). The exit code is non-zero on any error.

**Fix every error. Do not suppress.** The gate bans its own escape hatches: `@ts-ignore`,
`@ts-nocheck`, `@ts-expect-error`, blanket `eslint-disable`, any `eslint-disable` of a
harness rule, and any other `eslint-disable` without a `-- reason`.

Legacy violations live in two ratchet files. A file passes while its count for a rule is at or
below the recorded count; one more violation and all of them report. These files only shrink:

- `eslint-suppressions.json`: ESLint bulk suppressions. Prune with `eslint . --prune-suppressions`.
- `nuxt-harness-baseline.json`: static-check errors and CRAP hits per file. Rewrite with `nuxt-harness full --update-baseline`
  after fixing some, never to absorb new ones.

### Principle → deterministic check

| Principle | Enforced by |
|---|---|
| Structural invariants | `strict` TS (Nuxt 4 default), `no-explicit-any`, type-based `defineProps`/`defineEmits`, `vue/require-typed-ref`, `nuxt typecheck` |
| Single source of truth | schemas + inferred types, `vue/no-setup-props-reactivity-loss`, i18n key check, jscpd, knip |
| Illegal states | `arch/max-boolean-props`, `switch-exhaustiveness-check`, `no-unnecessary-condition` (type-aware) |
| Guards | `arch/max-condition-operands` (max 2 in `if`/`v-if`/`v-show`), `no-else-return`, `max-depth: 2`, auth gates only in middleware |
| Reactivity & SSR | `arch/max-watchers` (≤ 3 per file), no `provide`/`inject`, `navigateTo` awaited or returned, `<ClientOnly>` preceded by a reason |
| SSR determinism (invisible to typecheck and curl) | `arch/no-reserved-item-value` (reserved `''` in select items), `arch/no-nondeterministic-key`, `arch/use-fetch-needs-key`, `arch/no-locale-format-in-render`, `arch/no-browser-api-in-setup`, `arch/no-module-mutable-state`, `arch/timer-needs-scope-dispose` |
| Locality | R0–R4 layer rules, import boundaries (`app` ↛ `server`, `server` ↛ `app`, `shared` ↛ both), no event bus |
| CRAP | `complexity` ≤ 20; CRAP = c² × (1 − cov)³ + c ≤ 30 per `.ts` function (full gate) |
| Design system (opt-in) | hardcoded colors, palettes the app allows, nested bordered boxes |

### Layer rules (R0–R4)

- **R0 `arch/no-presenter-in-page`**: Pages render only `Orc*`/`Op*` (plus HTML, Nuxt built-ins, Nuxt UI atoms).
- **R1/R2 `arch/no-smart-calls`**: Presenters use no store, router, fetch or query primitive.
- **R3 `arch/no-data-calls-in-operator`**: Operators call no `$fetch`/`useFetch`/`useQuery`. They call composables.
- **R4 `arch/no-reverse-layer`**: no upward imports (Presenter ↛ Op/Orc, Op ↛ Orc).

See `references/eslint-rules.md` for every rule and `references/configuration.md` for the
options (i18n, auth composables, data-layer composables, design system).

---

## Before creating a component

1. What concerns does it have?
2. Does it load data? → Orchestrator. Does it wire Presenters? → Operator. Pure display? → Presenter.
3. Could a Presenter suffice, or is smart wiring needed?

Data + store + template → Orchestrator.
Wiring Presenters + local state, no data loading → Operator.
Props in, events out, no dependencies → Presenter.

---

## The atom layer (Nuxt UI)

When the app uses [Nuxt UI](https://ui.nuxt.com), its components are the atom layer: they sit
below Presenters. Use them directly, like HTML elements. (Another component library takes the
same place; the rules are the same.)

> Never create a thin wrapper around a primitive. `components/AppButton.vue` wrapping `UButton`
> is dead weight — use `UButton` directly.

| Layer | Nuxt UI usage |
|---|---|
| Presenter | Atoms (`UButton`, `UBadge`, `UAvatar`, `UCard`, `UIcon`, …) |
| Operator | Structural blocks (`UModal`, `USlideover`, `UTabs`, `UAccordion`) |
| Orchestrator | Forms (`UForm`, `UFormField`) with schema validation |
| Page | Layout primitives (`UContainer`, `USkeleton`) if needed |

```vue
<!-- color / variant / size: use the component's props, not raw utility classes -->
<UButton color="primary" variant="soft" size="sm" />

<!-- ui prop: per-slot class overrides, only when needed -->
<UCard :ui="{ body: 'p-0' }" />

<!-- icons: the app's Iconify collection, not custom SVG components -->
<UButton icon="i-lucide-plus" />
```

| Anti-pattern | Fix |
|---|---|
| `<button class="…">` styled by hand | `<UButton color="primary">` |
| `<input class="border rounded …">` | `<UInput>` |
| `AppModal.vue` wrapping `UModal` | `UModal` directly in the Operator |
| Manual `<table>` markup | `<UTable :data :columns>` |
| Raw `<select>` | `<USelect :items>` |
| `useToast()` in a Presenter | In an Orchestrator or composable |

---

## Gold standards

`references/gold-standards.md` has a complete, lint-clean implementation of each layer, a form,
the data layer (composables over `useFetch`, or a query cache), and a validated server route.

---

## Audit checklist

To audit an existing codebase, load `references/architecture.md` and apply the 7-signal method
(S1–S6 + S1b), scored out of 11.5. The top 5 components by score are the refactoring backlog.
