// @ts-check
/**
 * Gate orchestration.
 *
 *   fast  — static checks + harness ESLint rules on changed files. No install of the
 *           app, no `.nuxt/`, ~1–2 s. What agents run after every edit.
 *   full  — fast checks on every file + the app's own toolchain (nuxt typecheck,
 *           type-aware ESLint, knip, cspell, jscpd, vitest + CRAP). Needs the app installed.
 *   hook  — Claude Code PostToolUse adapter: reads the hook JSON on stdin, runs `fast`
 *           on the edited file, exits 2 with findings on stderr so the agent sees them.
 *   stop  — Claude Code Stop adapter: runs `fast` on every file changed on the branch
 *           (Bash edits included) and blocks the end of the turn while errors remain.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

import { STATIC_CHECKS } from './checks.js'
import { loadConfig, resolveOptions, sourcePattern } from './config.js'
import { applyBaseline, baselineFrom, crapFindings } from './crap.js'
import { lint } from './lint.js'

/** @typedef {import('./checks.js').Finding} Finding */
/** @typedef {{ name: string, status: 'pass' | 'fail' | 'skip', durationMs: number, findings: Finding[], note?: string }} CheckReport */

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const BASELINE_FILE = 'nuxt-harness-baseline.json'
const CRAP_CHECK = 'CRAP (complexity × coverage)'
const MAX_PRINTED = 15
// A Stop hook that always blocks would loop forever on an error the agent cannot fix.
const MAX_STOP_BLOCKS = 3

const tty = process.stdout.isTTY
const paint = (/** @type {string} */ code) => (/** @type {string} */ s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s
const red = paint('31'), green = paint('32'), yellow = paint('33'), dim = paint('2'), bold = paint('1')

// ─── File selection ─────────────────────────────────────────────────────────
/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  // Large untracked trees (an unignored node_modules) overflow the default 1 MB buffer.
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return r.status === 0 ? r.stdout.trim() : undefined
}

/** @param {string[]} files @param {RegExp} scope */
const inScope = (files, scope) => [...new Set(files)].filter(f => scope.test(f) && !f.endsWith('.d.ts'))

/**
 * Every file in scope. Prefers `git ls-files` (fast, honours .gitignore) and falls back to a
 * directory walk, so `--all` still means "all" outside a repository - otherwise the gate would
 * read nothing and report success.
 * @param {string} root @param {RegExp} scope
 */
function allFiles(root, scope) {
  const tracked = git(root, ['ls-files', '-co', '--exclude-standard'])
  if (tracked !== undefined) return inScope(tracked.split('\n'), scope)

  const SKIP = new Set(['node_modules', '.git', '.nuxt', '.output', '.harness', 'dist', '.data', 'coverage'])
  /** @type {string[]} */
  const found = []
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (SKIP.has(entry.name)) continue
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else found.push(rel)
    }
  }
  try {
    walk('.')
  } catch {
    return []
  }
  return inScope(found, scope)
}

/**
 * Working-tree changes + untracked files + commits since the merge-base with
 * the remote default branch (override with NUXT_HARNESS_BASE).
 * @param {string} root @param {RegExp} scope
 */
function changedFiles(root, scope) {
  const upstream = process.env.NUXT_HARNESS_BASE ?? git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  const base = upstream ? git(root, ['merge-base', 'HEAD', upstream]) : undefined
  const lists = [
    git(root, ['diff', '--name-only', '--diff-filter=ACMR', base ?? 'HEAD']),
    git(root, ['ls-files', '--others', '--exclude-standard'])
  ]
  return inScope(lists.join('\n').split('\n'), scope).filter(f => existsSync(join(root, f)))
}

// ─── Check runners ──────────────────────────────────────────────────────────
/**
 * @param {string} name
 * @param {() => Finding[] | Promise<Finding[]>} fn
 * @returns {Promise<CheckReport>}
 */
async function timed(name, fn) {
  const start = performance.now()
  const findings = await fn()
  return {
    name,
    status: findings.some(f => f.severity === 'error') ? 'fail' : 'pass',
    durationMs: Math.round(performance.now() - start),
    findings
  }
}

/** @param {string} root @param {string[]} files @param {import('./config.js').HarnessOptions} options */
function fastChecks(root, files, options) {
  const ctx = { root, files, options }
  return Promise.all([
    ...STATIC_CHECKS.map(c => timed(c.name, () => c.run(ctx))),
    timed('ESLint (harness rules)', () => lint(root, files, options))
  ])
}

// ─── Baseline ───────────────────────────────────────────────────────────────
// nuxt-harness-baseline.json records legacy violations the gate tolerates: CRAP hits and the
// static checks' errors, as file → count. ESLint keeps its own eslint-suppressions.json.
/** @typedef {{ crap?: Record<string, number>, checks?: Record<string, Record<string, number>> }} Baseline */

const BASELINED = new Set([...STATIC_CHECKS.map(c => c.name), CRAP_CHECK])

/** @param {string} root @returns {Baseline} */
function readBaseline(root) {
  const path = join(root, BASELINE_FILE)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

/** @param {Baseline} baseline @param {string} name */
const allowed = (baseline, name) => (name === CRAP_CHECK ? baseline.crap : baseline.checks?.[name]) ?? {}

/**
 * Records every baselined check's current errors. Rewrites the file: entries only ever shrink
 * when this runs after fixes, and it must never run to absorb new violations.
 * @param {CheckReport[]} checks @returns {Baseline}
 */
function baselineOf(checks) {
  /** @type {Baseline} */
  const baseline = { crap: {}, checks: {} }
  for (const c of checks) {
    if (!BASELINED.has(c.name)) continue
    const counts = baselineFrom(c.findings.filter(f => f.severity === 'error'))
    if (c.name === CRAP_CHECK) baseline.crap = counts
    else if (Object.keys(counts).length > 0) /** @type {Record<string, Record<string, number>>} */ (baseline.checks)[c.name] = counts
  }
  return baseline
}

/**
 * A check's errors pass per file while their count stays ≤ the recorded count; one more and all
 * of that file's errors report. Warnings are never baselined.
 * @param {CheckReport} check @param {Baseline} baseline @returns {CheckReport}
 */
function ratchet(check, baseline) {
  if (!BASELINED.has(check.name)) return check
  const errors = applyBaseline(check.findings.filter(f => f.severity === 'error'), allowed(baseline, check.name))
  const findings = [...errors, ...check.findings.filter(f => f.severity !== 'error')]
  return { ...check, findings, status: errors.length > 0 ? 'fail' : 'pass' }
}

/** The app's package manager, from its lockfile. @param {string} root */
function packageManager(root) {
  if (['bun.lock', 'bun.lockb'].some(f => existsSync(join(root, f)))) return 'bun'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * @typedef {{ name: string, script?: string, bin: string, args: string[], when?: string[] }} ToolStep
 *
 * The app's own toolchain. Each step runs its package.json script when the app
 * defines one (the app knows its globs), otherwise the bare binary. A step with
 * `when` runs only if one of those files exists.
 * @param {'app' | '.'} srcDir
 * @returns {ToolStep[]}
 */
function toolSteps(srcDir) {
  const appGlob = srcDir === 'app' ? 'app/**/*.{ts,vue}' : '{components,composables,layouts,middleware,pages,plugins,utils}/**/*.{ts,vue}'
  return [
    { name: 'TypeScript (nuxt typecheck)', bin: 'nuxt', args: ['typecheck'] },
    { name: 'ESLint (project, type-aware)', bin: 'eslint', args: ['.', '--max-warnings', '0'] },
    { name: 'Dead code (knip)', bin: 'knip', args: ['--reporter', 'compact'], when: ['knip.json', 'knip.jsonc', 'knip.config.ts'] },
    { name: 'Spelling (cspell)', script: 'check:spell', bin: 'cspell', args: [appGlob, 'server/**/*.ts', 'shared/**/*.ts', '--no-progress'], when: ['cspell.json', 'cspell.config.yaml', '.cspell.json'] },
    { name: 'Duplicates (jscpd)', bin: 'jscpd', args: ['--config', '.jscpd.json'], when: ['.jscpd.json'] },
    {
      name: 'Tests (vitest + coverage)',
      bin: 'vitest',
      args: ['run', '--coverage.enabled', '--coverage.reporter=json', '--coverage.reportsDirectory=.harness/coverage'],
      when: ['ts', 'mts', 'js', 'mjs'].map(ext => `vitest.config.${ext}`)
    }
  ]
}

const SIGNAL = /error|warning|✗|×|FAIL|Unknown word|clone|Unused|Unlisted|^\//i

/** @param {string} root @param {ToolStep} step @returns {Promise<CheckReport>} */
function runTool(root, step) {
  const start = performance.now()
  /** @param {CheckReport['status']} status @param {Finding[]} findings @param {string} [note] @returns {CheckReport} */
  const done = (status, findings, note) =>
    ({ name: step.name, status, durationMs: Math.round(performance.now() - start), findings, ...(note ? { note } : {}) })

  if (step.when && !step.when.some(f => existsSync(join(root, f)))) return Promise.resolve(done('skip', [], `no ${step.when[0]}`))
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}
  const binPath = join(root, 'node_modules', '.bin', step.bin)
  const useScript = step.script && scripts[step.script]
  if (!useScript && !existsSync(binPath)) {
    return Promise.resolve(done('fail', [{ check: step.name, file: 'package.json', line: 0, severity: 'error', message: `${step.bin} not installed — the full gate needs the app's dependencies installed` }]))
  }
  const [cmd, args] = useScript ? [packageManager(root), ['run', /** @type {string} */ (step.script)]] : [binPath, step.args]

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('close', (code) => {
      if (code === 0) return resolve(done('pass', []))
      const outLines = out.split('\n').map(l => l.trimEnd()).filter(Boolean)
      const signal = outLines.filter(l => SIGNAL.test(l))
      const picked = (signal.length > 0 ? signal : outLines.slice(-MAX_PRINTED))
      resolve(done('fail', picked.map(message => ({ check: step.name, file: '', line: 0, severity: 'error', message }))))
    })
  })
}

// ─── Output ─────────────────────────────────────────────────────────────────
/** @param {Finding} f */
const where = f => f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''

/** @param {Finding} f */
const describe = f => `${where(f)}${f.rule ? dim(`[${f.rule}] `) : ''}${f.message.split('\n').join('\n      ')}`

/** @param {CheckReport[]} checks @param {(s: string) => void} out */
function printHuman(checks, out) {
  for (const c of checks) {
    const label = c.status === 'pass' ? green('PASS') : c.status === 'skip' ? dim(`SKIP (${c.note})`) : red('FAIL')
    out(`  ${dim('→')} ${c.name.padEnd(32, '.')} ${label} ${dim(`${c.durationMs}ms`)}`)
    const errors = c.findings.filter(f => f.severity === 'error')
    const warnings = c.findings.filter(f => f.severity === 'warning')
    errors.slice(0, MAX_PRINTED).forEach(f => out(`    ${red('✗')} ${describe(f)}`))
    if (errors.length > MAX_PRINTED) out(dim(`    … ${errors.length - MAX_PRINTED} more errors in .harness/report.json`))
    warnings.slice(0, 5).forEach(f => out(`    ${yellow('⚠')} ${describe(f)}`))
  }
}

/** @param {string} root @param {object} report */
function writeReport(root, report) {
  mkdirSync(join(root, '.harness'), { recursive: true })
  writeFileSync(join(root, '.harness', 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

// ─── Entry ──────────────────────────────────────────────────────────────────
/** @param {string} cwd */
function projectRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd
}

/** @param {string} root @param {string} p */
const toRelative = (root, p) => isAbsolute(p) ? relative(root, p) : relative(root, join(process.cwd(), p))

/**
 * @param {'fast' | 'full'} mode
 * @param {{ root: string, files?: string[], all?: boolean, updateBaseline?: boolean, config?: import('./config.js').HarnessOptions, allowEmpty?: boolean }} options
 */
export async function runGate(mode, { root, files, all, updateBaseline, config, allowEmpty }) {
  const start = performance.now()
  const options = { ...(config ?? await loadConfig(root)), root }
  const { srcDir } = resolveOptions(options)
  const scope = sourcePattern(srcDir)
  const selected = mode === 'full' || all
    ? allFiles(root, scope)
    : files?.length ? inScope(files.map(f => toRelative(root, f)), scope) : changedFiles(root, scope)

  // An empty file set is not a pass: reporting success after reading nothing is how a green gate
  // hides a broken app. Say so, and let the caller opt in explicitly with --allow-empty.
  if (selected.length === 0 && !allowEmpty) {
    return {
      tool: '@edumapper/nuxt-harness',
      version: VERSION,
      mode,
      root,
      files: 0,
      durationMs: Math.round(performance.now() - start),
      passed: false,
      skipped: true,
      errors: 0,
      warnings: 0,
      checks: [{
        name: 'File selection',
        status: 'fail',
        durationMs: 0,
        findings: [{
          file: '.',
          line: 1,
          rule: 'harness/no-files',
          severity: 'error',
          message: [
            '❌ nothing to check — 0 files selected',
            '💡 A gate that reads no file cannot pass one. This happens outside a git repository when no file argument is given (the default is "changed files").',
            '🛠 Pass files: `nuxt-harness fast app/pages/index.vue`, or use `--all`. In CI with changesets that can legitimately be empty, pass `--allow-empty`.',
            '📖 https://github.com/edumapper/nuxt-harness/blob/main/skills/nuxt-harness/references/configuration.md'
          ].join('\n')
        }]
      }]
    }
  }

  /** @type {CheckReport[]} */
  let checks = await fastChecks(root, selected, options)
  if (mode === 'full') {
    const tools = await Promise.all(toolSteps(srcDir).map(step => runTool(root, step)))
    // CRAP joins complexity with the coverage the vitest step just wrote.
    const crapCheck = await timed(CRAP_CHECK, () => crapFindings(root, selected, options))
    checks = [...checks, ...tools, crapCheck]
  }

  // Only the full gate sees every file, so only it may rewrite the baseline.
  let baseline = readBaseline(root)
  if (mode === 'full' && updateBaseline) {
    baseline = baselineOf(checks)
    writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`)
  }
  checks = checks.map(c => ratchet(c, baseline))

  const errors = checks.flatMap(c => c.findings).filter(f => f.severity === 'error').length
  return {
    tool: '@edumapper/nuxt-harness',
    version: VERSION,
    mode,
    root,
    files: selected.length,
    durationMs: Math.round(performance.now() - start),
    passed: errors === 0,
    errors,
    warnings: checks.flatMap(c => c.findings).length - errors,
    checks
  }
}

/** @param {string[]} argv */
export async function main(argv) {
  const [command = 'fast', ...rest] = argv
  const json = rest.includes('--json')
  const all = rest.includes('--all')
  const updateBaseline = rest.includes('--update-baseline')
  const allowEmpty = rest.includes('--allow-empty')
  const files = rest.filter(a => !a.startsWith('--'))

  if (command === 'hook') return hook()
  if (command === 'stop') return stop()
  if (command !== 'fast' && command !== 'full') {
    process.stderr.write('usage: nuxt-harness <fast [files…] [--all] | full [--update-baseline] | hook | stop> [--json]\n')
    return 64
  }

  const root = projectRoot(process.cwd())
  const report = await runGate(command, { root, files, all, updateBaseline, allowEmpty })
  writeReport(root, report)

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const out = (/** @type {string} */ s) => process.stdout.write(`${s}\n`)
    out(`\n  ${bold(`@edumapper/nuxt-harness ${VERSION}`)} ${dim(`— ${command} gate, ${report.files} files`)}\n`)
    printHuman(report.checks, out)
    out(`\n  ${report.passed ? green(bold('✓ passed')) : red(bold(`✗ ${report.errors} errors`))}${report.warnings ? yellow(`  ⚠ ${report.warnings} warnings`) : ''} ${dim(`in ${report.durationMs}ms · .harness/report.json`)}\n`)
  }
  return report.passed ? 0 : 1
}

/** @returns {Promise<Record<string, any>>} the hook event JSON Claude Code writes on stdin */
async function readHookInput() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  return JSON.parse(input || '{}')
}

/** @param {Finding[]} errors @param {boolean} withFile */
function writeErrors(errors, withFile) {
  for (const f of errors.slice(0, MAX_PRINTED)) {
    const at = withFile ? `${f.file}${f.line ? `:${f.line}` : ''} ` : (f.line ? `L${f.line} ` : '')
    process.stderr.write(`  ✗ ${at}${f.rule ? `[${f.rule}] ` : ''}${f.message.split('\n').join('\n      ')}\n`)
  }
  if (errors.length > MAX_PRINTED) process.stderr.write(`  … ${errors.length - MAX_PRINTED} more in .harness/report.json\n`)
}

/** @param {{ checks: CheckReport[] }} report */
const errorsOf = report => report.checks.flatMap(c => c.findings).filter(f => f.severity === 'error')

/** Claude Code PostToolUse: exit 2 + stderr feeds the findings back to the agent. */
async function hook() {
  /** @type {string | undefined} */
  const file = (await readHookInput()).tool_input?.file_path
  if (!file) return 0
  // The edited file may live in a different worktree than the session's cwd. git reports real
  // paths, so resolve symlinks (macOS /var → /private/var, symlinked checkouts) before comparing.
  const abs = isAbsolute(file) ? file : join(process.cwd(), file)
  if (!existsSync(abs)) return 0
  const real = realpathSync(abs)
  const root = projectRoot(dirname(real))
  const rel = relative(root, real)

  const report = await runGate('fast', { root, files: [rel] })
  if (report.files === 0) return 0 // outside the harness scope
  const errors = errorsOf(report)
  if (errors.length === 0) return 0
  process.stderr.write(`nuxt-harness: ${errors.length} error(s) in ${rel} — fix before moving on:\n`)
  writeErrors(errors, false)
  return 2
}

/**
 * Claude Code Stop: the turn cannot end while files changed on the branch fail the fast gate.
 * Covers what the PostToolUse hook cannot see (files written through Bash, codegen). Blocks at
 * most MAX_STOP_BLOCKS times in a row per session, then lets the turn end and tells the user.
 */
async function stop() {
  const input = await readHookInput()
  const root = projectRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd())
  const report = await runGate('fast', { root })
  writeReport(root, report)
  const errors = errorsOf(report)

  const statePath = join(root, '.harness', 'stop-state.json')
  /** @type {{ session?: string, blocks?: number }} */
  let state = {}
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    state = {} // first stop of the session, or an unreadable leftover: start counting again
  }
  const blocks = state.session === input.session_id ? (state.blocks ?? 0) : 0
  const save = (/** @type {number} */ n) => writeFileSync(statePath, JSON.stringify({ session: input.session_id, blocks: n }))

  if (errors.length === 0) {
    save(0)
    return 0
  }
  if (blocks >= MAX_STOP_BLOCKS) {
    save(0)
    process.stdout.write(`${JSON.stringify({ systemMessage: `nuxt-harness: ${errors.length} error(s) remain in files changed on this branch after ${MAX_STOP_BLOCKS} attempts — see .harness/report.json` })}\n`)
    return 0
  }
  save(blocks + 1)
  process.stderr.write(`nuxt-harness: ${errors.length} error(s) in files changed on this branch — fix them before finishing (check ${blocks + 1}/${MAX_STOP_BLOCKS}):\n`)
  writeErrors(errors, true)
  return 2
}
