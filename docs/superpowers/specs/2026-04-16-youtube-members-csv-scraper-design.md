# YouTube Studio members.csv scraper — design

**Date:** 2026-04-16
**Status:** approved for implementation planning

## Purpose

`src/CreditRoll.tsx` reads `public/members.csv` at render time. The file is gitignored and must be refreshed before each credit-roll render. YouTube Studio does not expose a public API for the members export, so fetching it requires driving the Studio UI. This spec covers a Node + Playwright script that refreshes the CSV with one command while remaining difficult for YouTube to flag as automation.

## Goals & non-goals

**Goals**
- One-command refresh: `npm run fetch-members` writes `public/members.csv`.
- Use the user's real Chrome binary and real `Default` profile so cookies, extensions, and browser fingerprint match normal browsing.
- Minimize the surface that YouTube's bot detection can see: no `navigator.webdriver`, no "controlled by automation" banner, humanized inputs.
- Fail fast on any error. The user reruns.

**Non-goals**
- Headless operation.
- CI execution.
- Auto-chaining into `npm run build`.
- Retry loops, historical snapshots, or report reuse.
- Integration with any scheduling system.

## Decisions locked in during brainstorming

1. **Stack:** Node + `playwright-core` (no bundled browser download; we drive system Chrome directly).
2. **Browser attach model:** Script spawns Chrome itself as a **detached** child process with the flags we want, then `chromium.connectOverCDP()` attaches to it. At the end, `browser.disconnect()` drops the CDP connection without terminating Chrome. `launchPersistentContext` was rejected because it couples the browser lifecycle to the context — `context.close()` would kill Chrome, contradicting the "leave it running" requirement. Manual spawn also removes the need to strip `--enable-automation`, since we never add it.
3. **Chrome lifecycle:** Script graceful-quits any running Chrome first (AppleScript), waits for the profile `SingletonLock` to release, spawns a detached Chrome, attaches via CDP, runs the flow, then disconnects. Chrome remains open as the user's normal browser.
4. **Profile:** macOS `Default` profile at `~/Library/Application Support/Google/Chrome/`. Hardcoded.
5. **Error policy:** Fail fast on everything, including expired login. Single-line error to stderr, non-zero exit.
6. **CSV generation flow:** Async with polling. Click generate → poll for the report row to flip from "generating" to "ready" → click download.

## Architecture

```
scripts/
  fetch-members.ts         # entry point; orchestrates the flow end-to-end
  tsconfig.json            # isolated TS config so npm test can typecheck scripts too
  lib/
    chrome-lifecycle.ts    # quit running Chrome, wait for lock release
    humanize.ts            # humanized mouse, scroll, delays
    studio-flow.ts         # Studio navigation, report generation, polling, download
```

Playwright is a **dev dependency only**. `src/` never imports from `scripts/`, and the Remotion bundle is unaffected.

## Runtime flow

1. Preflight: verify `public/` exists, verify Chrome binary path, verify profile dir exists.
2. `chrome-lifecycle.quitAndWait()`:
   - Graceful quit via `osascript -e 'quit app "Google Chrome"'`.
   - Poll every 250ms for both the process to exit and `SingletonLock` to be absent; 10s cap.
   - Fail fast if either condition isn't met.
3. Spawn Chrome: `child_process.spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--user-data-dir=<userDataDir>', '--profile-directory=Default', '--remote-debugging-port=<random free port>', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref()`. Poll `http://127.0.0.1:<port>/json/version` until it responds (≤10s) to confirm readiness.
4. `const browser = await chromium.connectOverCDP('http://127.0.0.1:<port>')`. Use the first existing context (the persistent default) rather than creating a new one, so cookies and session storage from the real profile apply.
5. `studio-flow.run(context)`:
   - Open new page, navigate to `https://studio.youtube.com/`, `networkidle`, humanwait.
   - Navigate to memberships URL, `networkidle`.
   - Detect login screen (URL contains `accounts.google.com` or specific sign-in element). If detected, fail fast with the "Not signed in" message.
   - Humanscroll to the report export control.
   - humanClick generate → fill any date-range / format dialog (CSV) → humanClick confirm.
   - Poll for the newest report row's status to become "ready". Interval: 4s ± 1s. Cap: 5 min.
   - Register `page.waitForEvent('download')` before humanClick on the row's download action.
   - On download, save to `public/members.csv.tmp`, then `fs.rename` to `public/members.csv`. Atomic; a partial download can't leave the app in a broken state.
   - `page.close()`.
6. `browser.disconnect()` — drops the CDP connection. Chrome keeps running as the user's normal browser, on the debug port. (Security note: the debug port remains open until the user quits Chrome. Bound to `127.0.0.1` so it's local-only; acceptable for single-user dev workstations. If ever an issue, switch to a pipe-based scheme and accept that Chrome will exit with the script.)

## Selectors

YouTube Studio uses obfuscated compiled CSS classes that rotate. The script uses Playwright's semantic locators throughout:

- `page.getByRole('button', { name: /generate.*report/i })`
- `page.getByRole('dialog')`
- `page.getByRole('row')` + filter for status text
- `page.getByLabel(...)` where forms apply

Actual selector strings are TBD at implementation time. They'll be discovered by driving the live Studio page (Playwright MCP in the implementation session) and recorded in a single `SELECTORS` constant block at the top of `studio-flow.ts`. When Studio redesigns, that block is the only thing that needs to change.

## Anti-detection

The bulk of the defense is structural — real Chrome binary, real profile, real cookies, no `--enable-automation`, no automation flags. On top of that, `humanize.ts` provides humanized inputs used for every interaction:

- **`humanClick(locator)`** — read bounding box, pick a point with ±3px offset from center, move the mouse from its current position along a quadratic bezier with ~15 waypoints at 10–20ms spacing, settle 60–140ms, `mouse.down()`, hold 40–90ms, `mouse.up()`. `element.click()` is not used.
- **`humanWait(mean, spread)`** — Gaussian-biased delay, truncated. Inter-action: 300–900ms. Inter-poll: 3.5–4.5s.
- **`humanScroll(page, deltaY)`** — chunk scrolls into 120–180px wheel events at 40–90ms spacing. `scrollIntoView` is not used.
- **Warm-up** — navigate to `https://studio.youtube.com/` first, humanwait, then to the deep memberships URL. Avoids cold-start-direct-deep-link patterns.

Explicitly rejected:
- No stealth plugins (`playwright-extra` + `playwright-stealth`). They exist for Chromium; with real Chrome they add nothing and can contradict real defaults.
- No UA / viewport spoofing. Real profile already supplies correct values.
- No request interception. Leaves network fingerprint untouched.
- No headless mode.

Residual risk: process-tree / native-level fingerprinting. Not addressable browser-side. Very unlikely for web-delivered bot detection.

## Failure handling

All failures are fatal. Non-zero exit. Single-line message to stderr. No retries.

| Condition | Message |
|---|---|
| Chrome won't quit in 10s | `Chrome did not quit cleanly; close it and retry` |
| Profile lock won't release in 10s | `Profile lock stuck; check ~/Library/Application Support/Google/Chrome/Default/SingletonLock` |
| Chrome spawn fails | Propagate spawn error verbatim |
| CDP endpoint not reachable in 10s | `Chrome did not expose debug endpoint; check flags` |
| URL redirects to login | `Not signed in — log in in Chrome, then rerun` |
| Generate-report control not found | `UI changed; selectors in studio-flow.ts need updating` |
| Polling exceeds 5 min | `Report not ready after 5min; retry later` |
| Download event times out (60s after click) | `Download did not start; retry` |
| File write fails | Propagate fs error verbatim |

## Integration

**`package.json` additions:**
```json
{
  "scripts": {
    "fetch-members": "tsx scripts/fetch-members.ts"
  },
  "devDependencies": {
    "playwright-core": "<latest>",
    "tsx": "<latest>",
    "@types/node": "<latest>"
  }
}
```

**`scripts/tsconfig.json`** — isolated TypeScript config that extends the root and adds `"types": ["node"]` plus `"lib": ["es2022"]`. Allows the scripts directory to use Node APIs without contaminating the Remotion `src/` tsconfig.

**`npm test`** — updated to also run `tsc -p scripts/tsconfig.json` so `scripts/*.ts` are typechecked alongside `src/*.tsx`. Lint coverage for `scripts/` is optional; can be deferred.

**No changes** to `src/`, the main `tsconfig.json`, `remotion.config.ts`, or the Remotion bundle.

**`.gitignore`** — `public/members.csv` is already gitignored per `CLAUDE.md`. No change.

## Testing

There is no test infrastructure in this repo and the spec does not add one. Verification is manual:
- `npm test` must still pass (lint + typecheck over `src/` and `scripts/`).
- Running `npm run fetch-members` produces a well-formed `public/members.csv` matching `public/members.example.csv`'s column set.
- `npm start` loads the refreshed CSV without hanging on `delayRender`.
