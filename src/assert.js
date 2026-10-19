// @ts-check
/**
 * Runtime assertions — the one check that opens the built app in a browser.
 *
 * Static checks read source. They cannot see a value that is legal in source and fatal at render
 * time: a select item with a reserved empty-string value throws while the client hydrates it, and
 * the server-rendered HTML, `curl` and `nuxt typecheck` all stay green while every browser gets an
 * error page.
 *
 * This check is deliberately LOCAL-ONLY: it needs a browser, so it does not run in `fast`, it does
 * not run in `full` unless `--with-assert` is passed, and it refuses to run when a CI environment
 * is detected unless `--allow-ci` is explicit. It is a developer tool, not a CI gate.
 *
 * Every assertion is an invariant: exact, repeatable, and provable by running the check twice.
 * There is no timing budget, no retry, and no "probably fine": a route either matches the five
 * assertions or it does not.
 */
import { existsSync } from 'node:fs'

export const ASSERT_NAME = 'Runtime assertions'

/** Comma or space separated list → trimmed array. @param {string | undefined} value */
const list = value => String(value ?? '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean)

/** @param {import('./config.js').ResolvedOptions} options */
export function assertOptions (options) {
  const o = options.assert ?? {}
  return {
    routes: o.routes ?? [],
    expect404: o.expect404 ?? [],
    marker: o.marker ?? '',
    width: o.width ?? 390,
    height: o.height ?? 844,
    console: o.console ?? false,
    chrome: o.chrome ?? '',
    required: o.required ?? false
  }
}

/**
 * Merge CLI flags over the config. One place decides what the check reads, so a flag cannot be
 * silently dropped between the CLI and the evaluator.
 * @param {import('./config.js').ResolvedOptions} options
 * @param {{ routes?: string[], expect404?: string[], marker?: string }} flags
 */
export function resolveAssertInputs (options, flags = {}) {
  const configured = assertOptions(options)
  return {
    ...configured,
    routes: flags.routes?.length ? flags.routes : configured.routes,
    expect404: flags.expect404?.length ? flags.expect404 : configured.expect404,
    marker: flags.marker ?? configured.marker
  }
}

/**
 * A Chrome/Chromium binary, or undefined. Pinned by option or `NUXT_HARNESS_CHROME`, so the same
 * input always uses the same browser.
 * @param {string} configured
 */
export function findChrome (configured) {
  const candidates = [
    configured,
    process.env.NUXT_HARNESS_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(/** @type {string} */ (candidate)))
}

/**
 * @typedef {{ route: string, expectedStatus: number, status: number, ssrHtml: string, domHtml: string, consoleErrors: string[], marker: string, console: boolean, scrollWidth?: number, innerWidth?: number }} Observation
 */

/** @param {string} marker @param {string} html */
const hasMarker = (marker, html) => html.includes(marker)

/**
 * The five invariants. Pure: the same observation always yields the same findings.
 * @param {Observation} observation
 * @returns {import('./checks.js').Finding[]}
 */
export function evaluateRoute (observation) {
  /** @type {import('./checks.js').Finding[]} */
  const findings = []
  const at = { check: ASSERT_NAME, file: observation.route, line: 1 }

  const error = (rule, lines) => findings.push({ ...at, rule, severity: 'error', message: lines.join('\n') })

  if (observation.status !== observation.expectedStatus) {
    error('harness/assert-status', [
      `❌ ${observation.route} answered ${observation.status}, expected ${observation.expectedStatus}`,
      '💡 The status is part of the contract: a soft 404 is indexed as a success and hides the failure from monitoring.',
      '🛠 Throw createError({ statusCode }) for real failures; add the route to assert.expect404 if a 404 is correct.'
    ])
  }

  if (observation.marker && !hasMarker(observation.marker, observation.ssrHtml)) {
    error('harness/assert-ssr-marker', [
      `❌ ${observation.route} server HTML does not contain ${JSON.stringify(observation.marker)}`,
      '💡 The first response must already contain the content: no server render means no crawlable HTML and a blank first paint.',
      '🛠 Set assert.marker to a string the page must render (a heading, a data attribute), or fix the SSR path.'
    ])
  }

  // Only a *loss* between the two renders is a hydration failure. When the marker is missing from
  // both, the server-marker finding above already says so and this one would be a false claim.
  if (observation.marker && hasMarker(observation.marker, observation.ssrHtml) && !hasMarker(observation.marker, observation.domHtml)) {
    error('harness/assert-hydrated-marker', [
      `❌ ${observation.route} server HTML contains ${JSON.stringify(observation.marker)}, the hydrated DOM does not`,
      '💡 The server rendered fine, then the client render threw and the page was replaced. curl and typecheck cannot see this.',
      '🛠 Open the page in a browser and read the console: a third-party component throwing on a reserved prop value, a browser API read during setup, or data the template assumed.'
    ])
  }

  if (observation.console && observation.consoleErrors.length > 0) {
    error('harness/assert-console', [
      `❌ ${observation.route} logged ${observation.consoleErrors.length} console error(s)`,
      `💡 ${observation.consoleErrors[0].slice(0, 200)}`,
      '🛠 Fix the error. A console error during hydration usually means the page is degraded even when it looks correct.'
    ])
  }

  // Geometry needs a CDP-capable runner. When it is not measured, the invariant is skipped rather
  // than assumed true: an invented value would be a fake signal.
  if (typeof observation.scrollWidth === 'number' && typeof observation.innerWidth === 'number'
    && observation.scrollWidth > observation.innerWidth) {
    error('harness/assert-overflow', [
      `❌ ${observation.route} is wider than the viewport (${observation.scrollWidth} > ${observation.innerWidth}) at ${observation.innerWidth}px`,
      '💡 A page wider than the screen scrolls sideways on a phone.',
      '🛠 Remove fixed widths, or let the overflowing child shrink (min-w-0, truncate, overflow-x-auto).'
    ])
  }

  return findings
}

/**
 * Should the check run at all? Pure, so the decision is testable without a browser.
 * @param {{ requested: boolean, inCi: boolean, allowCi: boolean, chrome: string | undefined, routes: string[] }} input
 * @returns {{ run: boolean, note: string }}
 */
export function assertDecision (input) {
  if (!input.requested) return { run: false, note: 'local-only: pass --with-assert to run it here' }
  if (input.inCi && !input.allowCi) return { run: false, note: 'local-only: CI detected (pass --allow-ci to override)' }
  if (input.routes.length === 0) return { run: false, note: 'no routes: set assert.routes or pass --routes' }
  if (!input.chrome) return { run: false, note: 'no Chrome found: set NUXT_HARNESS_CHROME' }
  return { run: true, note: '' }
}

/**
 * A skipped check is visible, and only fails the gate when the caller declares it required.
 * @param {import('./run.js').CheckReport[]} checks @param {string[]} required
 * @returns {import('./run.js').CheckReport[]}
 */
export function applyRequired (checks, required) {
  if (required.length === 0) return checks
  return checks.map((check) => {
    if (check.status !== 'skip' || !required.includes(check.name)) return check
    return {
      ...check,
      status: 'fail',
      findings: [...check.findings, {
        check: check.name,
        file: '.',
        line: 1,
        rule: 'harness/required-check-skipped',
        severity: 'error',
        message: [
          `❌ required check skipped: ${check.name} (${check.note ?? 'no reason given'})`,
          '💡 A check that is declared required must run: a skip that stays green is how a broken app ships.',
          `🛠 Make it runnable here, or drop ${check.name} from --require / the config.`
        ].join('\n')
      }]
    }
  })
}

export { list as parseList }
