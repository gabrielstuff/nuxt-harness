import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { runGate } from '../src/run.js'

const root = mkdtempSync(join(tmpdir(), 'nuxt-harness-gate-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const BIN = fileURLToPath(new URL('../bin/nuxt-harness.js', import.meta.url))

/** A repository whose working tree matches HEAD: the changed-files mode selects nothing. */
function cleanRepo(name: string) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'app/pages'), { recursive: true })
  writeFileSync(join(repo, 'app/pages/index.vue'), '<template><div /></template>\n')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) {
    spawnSync('git', args, { cwd: repo })
  }
  return repo
}

// A gate that reads no file must never report success: that is how a green run hides a broken app.
describe('file selection is not allowed to be vacuously green', () => {
  it('fails when nothing can be selected', async () => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const report = await runGate('fast', { root: empty, all: true })
    expect(report.files).toBe(0)
    expect(report.passed).toBe(false)
    expect(report.skipped).toBe(true)
    expect(report.checks[0]?.findings[0]?.rule).toBe('harness/no-files')
  })

  it('--allow-empty opts in explicitly', async () => {
    const empty = join(root, 'empty-ok')
    mkdirSync(empty, { recursive: true })
    const report = await runGate('fast', { root: empty, all: true, allowEmpty: true })
    expect(report.files).toBe(0)
    expect(report.passed).toBe(true)
  })

  it('passes when nothing changed in a repository (changed-files mode)', async () => {
    const report = await runGate('fast', { root: cleanRepo('clean-repo') })
    expect(report.files).toBe(0)
    expect(report.passed).toBe(true)
    expect(report.skipped).toBeUndefined()
  })

  it('the Stop hook lets the turn end on a clean branch', () => {
    const repo = cleanRepo('clean-repo-stop')
    const run = spawnSync('node', [BIN, 'stop'], { input: JSON.stringify({ session_id: 's', cwd: repo }), encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('still fails an empty explicit selection inside a repository', async () => {
    const report = await runGate('fast', { root: cleanRepo('clean-repo-explicit'), files: ['README.md'] })
    expect(report.passed).toBe(false)
    expect(report.checks[0]?.findings[0]?.rule).toBe('harness/no-files')
  })

  it('--all finds files without a git repository', async () => {
    const project = join(root, 'project')
    mkdirSync(join(project, 'app/pages'), { recursive: true })
    writeFileSync(join(project, 'app/pages/index.vue'), '<template><div /></template>\n')
    const report = await runGate('fast', { root: project, all: true })
    expect(report.files).toBe(1)
    expect(report.passed).toBe(true)
  })
})
