import { describe, expect, it } from 'vitest'

import { applyRequired, assertDecision, evaluateRoute, parseList, resolveAssertInputs } from '../src/assert.js'

const base = {
  route: '/',
  expectedStatus: 200,
  status: 200,
  ssrHtml: '<html><body><ul id="results"><li>A1101</li></ul></body></html>',
  domHtml: '<html><body><ul id="results"><li>A1101</li></ul></body></html>',
  consoleErrors: [],
  marker: 'A1101',
  console: false
}

const rules = (findings: { rule?: string }[]) => findings.map(f => f.rule)

// Five invariants, each independent, each exact. No timing, no retry, no tolerance.
describe('runtime assertions', () => {
  it('passes when server and hydrated DOM agree', () => {
    expect(evaluateRoute({ ...base })).toEqual([])
  })

  it('catches the shipped bug: server HTML is fine, the hydrated DOM lost it', () => {
    const findings = evaluateRoute({ ...base, domHtml: '<html><body><h1>500 Internal Server Error</h1></body></html>' })
    expect(rules(findings)).toEqual(['harness/assert-hydrated-marker'])
  })

  it('catches a soft 404 and accepts an expected one', () => {
    expect(rules(evaluateRoute({ ...base, status: 200, expectedStatus: 404 }))).toEqual(['harness/assert-status'])
    expect(evaluateRoute({ ...base, route: '/item/nope', status: 404, expectedStatus: 404, ssrHtml: '', domHtml: '', marker: '' })).toEqual([])
  })

  it('catches a missing server marker (no SSR content)', () => {
    expect(rules(evaluateRoute({ ...base, ssrHtml: '<html><body><div id="app"></div></body></html>' }))).toEqual(['harness/assert-ssr-marker'])
  })

  it('reports one finding when the marker is absent from both renders', () => {
    const absent = '<html><body><div id="app"></div></body></html>'
    expect(rules(evaluateRoute({ ...base, ssrHtml: absent, domHtml: absent }))).toEqual(['harness/assert-ssr-marker'])
  })

  it('checks console errors only when asked', () => {
    expect(evaluateRoute({ ...base, consoleErrors: ['Uncaught TypeError'] })).toEqual([])
    expect(rules(evaluateRoute({ ...base, console: true, consoleErrors: ['Uncaught TypeError'] }))).toEqual(['harness/assert-console'])
  })

  it('checks geometry only when a runner measured it', () => {
    expect(evaluateRoute({ ...base })).toEqual([])
    expect(rules(evaluateRoute({ ...base, scrollWidth: 420, innerWidth: 390 }))).toEqual(['harness/assert-overflow'])
  })

  it('is deterministic: the same observation yields the same findings', () => {
    const observation = { ...base, domHtml: '<html><body></body></html>' }
    expect(JSON.stringify(evaluateRoute(observation))).toBe(JSON.stringify(evaluateRoute(observation)))
  })
})

// Local-only by design: `assert` must never be a CI gate unless the caller says so.
describe('assert is local-only', () => {
  it('skips when not requested', () => {
    expect(assertDecision({ requested: false, inCi: false, allowCi: false, chrome: '/chrome', routes: ['/'] }))
      .toEqual({ run: false, note: 'local-only: pass --with-assert to run it here' })
  })

  it('refuses to run in CI unless --allow-ci is explicit', () => {
    expect(assertDecision({ requested: true, inCi: true, allowCi: false, chrome: '/chrome', routes: ['/'] }).run).toBe(false)
    expect(assertDecision({ requested: true, inCi: true, allowCi: false, chrome: '/chrome', routes: ['/'] }).note).toContain('CI detected')
    expect(assertDecision({ requested: true, inCi: true, allowCi: true, chrome: '/chrome', routes: ['/'] }).run).toBe(true)
  })

  it('skips visibly when there is no browser or no route', () => {
    expect(assertDecision({ requested: true, inCi: false, allowCi: false, chrome: undefined, routes: ['/'] }).note).toContain('no Chrome')
    expect(assertDecision({ requested: true, inCi: false, allowCi: false, chrome: '/chrome', routes: [] }).note).toContain('no routes')
  })
})

// A skip is visible by default; it only fails the gate when the caller declares the check required.
describe('required checks', () => {
  const skipped = [{ name: 'Runtime assertions', status: 'skip' as const, note: 'local-only', durationMs: 0, findings: [] }]

  it('stays green when nothing is required', () => {
    expect(applyRequired(skipped, [])[0]?.status).toBe('skip')
  })

  it('fails when the skipped check is required', () => {
    const [check] = applyRequired(skipped, ['Runtime assertions'])
    expect(check?.status).toBe('fail')
    expect(check?.findings[0]?.rule).toBe('harness/required-check-skipped')
  })

  it('does not touch other checks', () => {
    const mixed = [{ name: 'Console hygiene', status: 'skip' as const, note: 'x', durationMs: 0, findings: [] }]
    expect(applyRequired(mixed, ['Runtime assertions'])[0]?.status).toBe('skip')
  })
})

// The live run exposed this: a flag that never reaches the evaluator looks like a passing check.
describe('flag resolution', () => {
  const options = { assert: { routes: ['/from-config'], expect404: [], marker: 'FROM_CONFIG', width: 390, height: 844, console: false, chrome: '', required: false } }

  it('uses config values when no flag is given', () => {
    expect(resolveAssertInputs(options, {}).marker).toBe('FROM_CONFIG')
    expect(resolveAssertInputs(options, {}).routes).toEqual(['/from-config'])
  })

  it('lets flags win', () => {
    const resolved = resolveAssertInputs(options, { routes: ['/from-flag'], marker: 'FROM_FLAG', expect404: ['/gone'] })
    expect(resolved.marker).toBe('FROM_FLAG')
    expect(resolved.routes).toEqual(['/from-flag'])
    expect(resolved.expect404).toEqual(['/gone'])
  })

  it('keeps other config values (width, console)', () => {
    const resolved = resolveAssertInputs(options, { marker: 'X' })
    expect(resolved.width).toBe(390)
    expect(resolved.console).toBe(false)
  })
})

describe('route parsing', () => {
  it('accepts comma or space separated routes', () => {
    expect(parseList('/,/?q=x, /item/1')).toEqual(['/', '/?q=x', '/item/1'])
    expect(parseList(undefined)).toEqual([])
  })
})
