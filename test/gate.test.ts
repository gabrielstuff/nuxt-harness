import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runGate } from '../src/run.js'

const root = mkdtempSync(join(tmpdir(), 'nuxt-harness-gate-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

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

  it('--all finds files without a git repository', async () => {
    const project = join(root, 'project')
    mkdirSync(join(project, 'app/pages'), { recursive: true })
    writeFileSync(join(project, 'app/pages/index.vue'), '<template><div /></template>\n')
    const report = await runGate('fast', { root: project, all: true })
    expect(report.files).toBe(1)
    expect(report.passed).toBe(true)
  })
})
