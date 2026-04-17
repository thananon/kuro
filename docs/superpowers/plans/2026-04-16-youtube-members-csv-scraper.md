# YouTube members.csv scraper — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `npm run fetch-members`, a Node + Playwright script that refreshes `public/members.csv` by driving YouTube Studio in the user's real Chrome/Default profile, with humanized inputs to reduce bot-detection surface.

**Architecture:** A single TypeScript entry point (`scripts/fetch-members.ts`) orchestrates four concerns split across `scripts/lib/`: graceful Chrome lifecycle, detached Chrome spawn + CDP attach, humanized input synthesis, and Studio navigation/polling. Playwright connects to a user-launched Chrome (not `launchPersistentContext`) so `browser.disconnect()` hands control back without killing Chrome.

**Tech Stack:** TypeScript, `playwright-core` (driven via CDP; no bundled Chromium), `tsx` (zero-config TS runner), `@types/node`. macOS-only (relies on AppleScript quit and the macOS Chrome path).

**Per-project note on testing:** This repo has no test runner — `npm test` is lint + typecheck only (see `CLAUDE.md`). The design spec explicitly chose not to add one. Each task below verifies via (a) `npm test` for compile correctness and (b) a manual run step. Strict unit-test TDD is not applied.

**Reference spec:** `docs/superpowers/specs/2026-04-16-youtube-members-csv-scraper-design.md`

---

## File structure

Files this plan creates or modifies:

| File | Responsibility |
|---|---|
| `scripts/fetch-members.ts` | Entry point; orchestrates preflight → lifecycle → spawn → attach → studio flow → disconnect |
| `scripts/lib/chrome-lifecycle.ts` | Graceful-quit Chrome via AppleScript; poll `SingletonLock` |
| `scripts/lib/chrome-spawn.ts` | Spawn detached Chrome with debug port; wait for CDP endpoint |
| `scripts/lib/humanize.ts` | `gaussianDelay`, `humanWait`, `humanClick`, `humanScroll`, bezier waypoints |
| `scripts/lib/studio-flow.ts` | Studio navigation, login detection, report generation, polling, download |
| `scripts/tsconfig.json` | Isolated TS config for `scripts/` (adds `node` types, `dom` lib) |
| `package.json` | Add `fetch-members` npm script; add `playwright-core`, `tsx`, `@types/node` dev deps; extend `test` script to typecheck scripts too |

---

## Task 1: Add dev dependencies, `scripts/` tsconfig, and npm script wiring

**Files:**
- Modify: `package.json`
- Create: `scripts/tsconfig.json`

- [ ] **Step 1: Install new dev dependencies**

Run:
```bash
npm install --save-dev playwright-core@^1.59.1 tsx@^4.21.0 @types/node@^25.6.0
```

Expected: packages added; no vulnerabilities.

- [ ] **Step 2: Add `fetch-members` script and extend `test`**

Edit `package.json` scripts block to read:
```json
"scripts": {
  "start": "remotion preview src/index.tsx",
  "build": "remotion render src/index.tsx CreditRoll out/CreditRoll.mp4",
  "upgrade": "remotion upgrade",
  "test": "eslint src --ext ts,tsx,js,jsx && tsc && tsc -p scripts/tsconfig.json",
  "fetch-members": "tsx scripts/fetch-members.ts"
}
```

- [ ] **Step 3: Create `scripts/tsconfig.json`**

Create with this exact content:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["./**/*.ts"]
}
```

Rationale: DOM lib is included here (unlike the Remotion tsconfig which uses `@types/web`) because Playwright's `page.evaluate` callbacks run in a DOM context and depend on lib.dom types. This isolation is exactly why we're using a separate tsconfig.

- [ ] **Step 4: Create a placeholder script file so `tsc -p scripts/tsconfig.json` has something to check**

Create `scripts/fetch-members.ts`:
```ts
// Placeholder. Real implementation lands in Task 2.
export {};
```

- [ ] **Step 5: Verify `npm test` passes**

Run: `npm test`
Expected: lint clean, both tsc invocations succeed, exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/tsconfig.json scripts/fetch-members.ts
git commit -m "chore: scaffold scripts/ with playwright-core, tsx, and tsconfig"
```

---

## Task 2: Preflight checks in entry point

**Files:**
- Modify: `scripts/fetch-members.ts`

- [ ] **Step 1: Replace placeholder with preflight implementation**

Full content of `scripts/fetch-members.ts`:
```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DATA_DIR = path.join(
	os.homedir(),
	'Library',
	'Application Support',
	'Google',
	'Chrome',
);
const PROFILE_DIR = path.join(USER_DATA_DIR, 'Default');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const OUTPUT_CSV = path.join(PUBLIC_DIR, 'members.csv');

function die(msg: string): never {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

function preflight(): void {
	if (process.platform !== 'darwin') {
		die('This script is macOS-only.');
	}
	if (!fs.existsSync(CHROME_BIN)) {
		die(`Chrome not found at ${CHROME_BIN}`);
	}
	if (!fs.existsSync(PROFILE_DIR)) {
		die(`Chrome Default profile not found at ${PROFILE_DIR}`);
	}
	if (!fs.existsSync(PUBLIC_DIR)) {
		die(`public/ directory not found at ${PUBLIC_DIR}`);
	}
}

async function main(): Promise<void> {
	preflight();
	process.stdout.write('preflight OK\n');
	// Subsequent tasks add: quit Chrome, spawn Chrome, attach CDP, run studio flow.
	void OUTPUT_CSV;
}

main().catch((err) => {
	die(err instanceof Error ? err.message : String(err));
});
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 3: Verify script runs and prints "preflight OK"**

Run: `npm run fetch-members`
Expected: stdout contains `preflight OK`, exit 0.

- [ ] **Step 4: Verify failure path**

Run: `( REPO="$PWD" && cd /tmp && "$REPO/node_modules/.bin/tsx" "$REPO/scripts/fetch-members.ts" )` (invokes from a directory without `public/`).
Expected: stderr contains `public/ directory not found`, exit 1.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-members.ts
git commit -m "feat(scripts): preflight checks for fetch-members"
```

---

## Task 3: Chrome lifecycle — graceful quit + lock release

**Files:**
- Create: `scripts/lib/chrome-lifecycle.ts`
- Modify: `scripts/fetch-members.ts`

- [ ] **Step 1: Create `scripts/lib/chrome-lifecycle.ts`**

Full content:
```ts
import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);
const TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

async function isChromeRunning(): Promise<boolean> {
	try {
		await execFileP('pgrep', ['-x', 'Google Chrome']);
		return true;
	} catch {
		return false;
	}
}

async function tellChromeToQuit(): Promise<void> {
	await execFileP('osascript', ['-e', 'tell application "Google Chrome" to quit']);
}

function lockExists(userDataDir: string): boolean {
	return fs.existsSync(path.join(userDataDir, 'SingletonLock'));
}

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return false;
}

export async function quitAndWait(userDataDir: string): Promise<void> {
	if (!(await isChromeRunning()) && !lockExists(userDataDir)) {
		return;
	}

	if (await isChromeRunning()) {
		await tellChromeToQuit();
	}

	const quit = await waitUntil(async () => !(await isChromeRunning()), TIMEOUT_MS);
	if (!quit) {
		throw new Error('Chrome did not quit cleanly; close it and retry');
	}

	const unlocked = await waitUntil(() => !lockExists(userDataDir), TIMEOUT_MS);
	if (!unlocked) {
		throw new Error(
			`Profile lock stuck; check ${path.join(userDataDir, 'SingletonLock')}`,
		);
	}
}
```

- [ ] **Step 2: Call it from the entry point**

In `scripts/fetch-members.ts`, add import and invoke after preflight:
```ts
import {quitAndWait} from './lib/chrome-lifecycle';
```
Then in `main()` after `preflight()`:
```ts
await quitAndWait(USER_DATA_DIR);
process.stdout.write('Chrome quit; profile lock released\n');
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 4: Manual verification — Chrome running**

With Chrome open:
Run: `npm run fetch-members`
Expected: Chrome quits, stdout shows both `preflight OK` and `Chrome quit; profile lock released`.

- [ ] **Step 5: Manual verification — Chrome not running**

With Chrome closed:
Run: `npm run fetch-members`
Expected: same two lines; no-op quit path.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/chrome-lifecycle.ts scripts/fetch-members.ts
git commit -m "feat(scripts): graceful Chrome quit and profile-lock polling"
```

---

## Task 4: Detached Chrome spawn + CDP attach + clean disconnect

**Files:**
- Create: `scripts/lib/chrome-spawn.ts`
- Modify: `scripts/fetch-members.ts`

- [ ] **Step 1: Create `scripts/lib/chrome-spawn.ts`**

Full content:
```ts
import {spawn} from 'node:child_process';
import * as net from 'node:net';

const READY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

export interface SpawnedChrome {
	port: number;
	cdpUrl: string;
}

function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (typeof addr !== 'object' || !addr) {
				reject(new Error('could not pick free port'));
				return;
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

async function endpointReady(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		return res.ok;
	} catch {
		return false;
	}
}

export async function spawnChrome(
	chromeBin: string,
	userDataDir: string,
): Promise<SpawnedChrome> {
	const port = await pickFreePort();
	const child = spawn(
		chromeBin,
		[
			`--user-data-dir=${userDataDir}`,
			`--profile-directory=Default`,
			`--remote-debugging-port=${port}`,
			'--no-first-run',
			'--no-default-browser-check',
		],
		{detached: true, stdio: 'ignore'},
	);
	child.unref();

	const start = Date.now();
	while (Date.now() - start < READY_TIMEOUT_MS) {
		if (await endpointReady(port)) {
			return {port, cdpUrl: `http://127.0.0.1:${port}`};
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error('Chrome did not expose debug endpoint; check flags');
}
```

- [ ] **Step 2: Wire CDP attach + disconnect into the entry point**

In `scripts/fetch-members.ts`, add imports:
```ts
import {chromium} from 'playwright-core';
import {spawnChrome} from './lib/chrome-spawn';
```
In `main()` after `quitAndWait(...)`:
```ts
const {cdpUrl} = await spawnChrome(CHROME_BIN, USER_DATA_DIR);
process.stdout.write(`Chrome spawned (CDP: ${cdpUrl})\n`);

const browser = await chromium.connectOverCDP(cdpUrl);
try {
	const [context] = browser.contexts();
	if (!context) {
		throw new Error('no default browser context');
	}
	process.stdout.write(`attached; ${context.pages().length} existing page(s)\n`);
	// Studio flow lands in Task 6+.
} finally {
	await browser.disconnect();
}
process.stdout.write('disconnected; Chrome left running\n');
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 4: Manual verification**

Run: `npm run fetch-members`
Expected:
- Chrome relaunches (visible window).
- Stdout shows `Chrome spawned (CDP: http://127.0.0.1:<port>)`, then `attached; ... existing page(s)`, then `disconnected; Chrome left running`.
- **Chrome window stays open** after the script exits.
- In the open Chrome, open a new tab to `chrome://version/` — the "Command Line" row should NOT contain `--enable-automation`. Opening DevTools and running `navigator.webdriver` in the console should print `undefined` (or `false` on some versions), not `true`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/chrome-spawn.ts scripts/fetch-members.ts
git commit -m "feat(scripts): spawn detached Chrome and attach via CDP"
```

---

## Task 5: Humanize primitives — delay, bezier path, click, scroll

**Files:**
- Create: `scripts/lib/humanize.ts`

- [ ] **Step 1: Create `scripts/lib/humanize.ts`**

Full content:
```ts
import type {Locator, Page} from 'playwright-core';

type Point = {x: number; y: number};

// Box-Muller transform, truncated to ±2 sigma.
function gaussian(): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	return Math.max(-2, Math.min(2, z));
}

export function gaussianDelay(meanMs: number, spreadMs: number): number {
	return Math.max(0, Math.round(meanMs + (gaussian() / 2) * spreadMs));
}

export async function humanWait(meanMs: number, spreadMs: number): Promise<void> {
	await new Promise((r) => setTimeout(r, gaussianDelay(meanMs, spreadMs)));
}

function quadraticBezier(p0: Point, p1: Point, p2: Point, t: number): Point {
	const mt = 1 - t;
	return {
		x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
		y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
	};
}

export function bezierWaypoints(from: Point, to: Point, count = 15): Point[] {
	const midX = (from.x + to.x) / 2;
	const midY = (from.y + to.y) / 2;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.max(1, Math.hypot(dx, dy));
	// Control point offset perpendicular to the line, magnitude ~10% of distance.
	const perpX = (-dy / len) * len * 0.1 * (Math.random() - 0.5) * 2;
	const perpY = (dx / len) * len * 0.1 * (Math.random() - 0.5) * 2;
	const ctrl = {x: midX + perpX, y: midY + perpY};
	const pts: Point[] = [];
	for (let i = 1; i <= count; i++) {
		pts.push(quadraticBezier(from, ctrl, to, i / count));
	}
	return pts;
}

let cursorX = 0;
let cursorY = 0;

export async function humanClick(page: Page, locator: Locator): Promise<void> {
	const box = await locator.boundingBox();
	if (!box) throw new Error('humanClick: target has no bounding box');
	const target: Point = {
		x: box.x + box.width / 2 + (Math.random() * 6 - 3),
		y: box.y + box.height / 2 + (Math.random() * 6 - 3),
	};
	const waypoints = bezierWaypoints({x: cursorX, y: cursorY}, target);
	for (const pt of waypoints) {
		await page.mouse.move(pt.x, pt.y);
		await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 10)));
	}
	cursorX = target.x;
	cursorY = target.y;
	await humanWait(100, 80);
	await page.mouse.down();
	await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 50)));
	await page.mouse.up();
}

export async function humanScroll(page: Page, deltaY: number): Promise<void> {
	const chunkSize = deltaY > 0 ? 150 : -150;
	let remaining = deltaY;
	while (Math.abs(remaining) > 0) {
		const step = Math.abs(remaining) < Math.abs(chunkSize) ? remaining : chunkSize;
		const jittered = step + (Math.random() * 60 - 30);
		await page.mouse.wheel(0, jittered);
		remaining -= step;
		await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 50)));
	}
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 3: Sanity-check the math with a temporary harness**

Create `scripts/lib/humanize.sanity.ts` (temporary — deleted in Step 5):
```ts
import * as assert from 'node:assert/strict';
import {bezierWaypoints, gaussianDelay} from './humanize';

const delays = Array.from({length: 1000}, () => gaussianDelay(500, 200));
const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
assert.ok(mean > 400 && mean < 600, `mean out of range: ${mean}`);
assert.ok(Math.min(...delays) >= 0, 'negative delay produced');

const pts = bezierWaypoints({x: 0, y: 0}, {x: 100, y: 100}, 15);
assert.equal(pts.length, 15);
assert.ok(Math.abs(pts[pts.length - 1].x - 100) < 0.01);
assert.ok(Math.abs(pts[pts.length - 1].y - 100) < 0.01);

process.stdout.write('humanize sanity OK\n');
```

Run: `npx tsx scripts/lib/humanize.sanity.ts`
Expected: `humanize sanity OK`, exit 0.

- [ ] **Step 4: Verify typecheck still passes with harness present**

Run: `npm test`
Expected: passes.

- [ ] **Step 5: Remove the harness**

Run: `rm scripts/lib/humanize.sanity.ts`

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/humanize.ts
git commit -m "feat(scripts): humanized input primitives"
```

---

## Task 6: Studio flow — navigation + login detection

**Files:**
- Create: `scripts/lib/studio-flow.ts`
- Modify: `scripts/fetch-members.ts`

- [ ] **Step 1: Create `scripts/lib/studio-flow.ts` with navigation + login check only**

Full content:
```ts
import type {BrowserContext, Page} from 'playwright-core';
import {humanWait} from './humanize';

const STUDIO_URL = 'https://studio.youtube.com/';
const MEMBERSHIPS_URL =
	'https://studio.youtube.com/channel/UCoiEtD4v1qMAqHV5MDI5Qpg/monetization/memberships';

async function assertLoggedIn(page: Page): Promise<void> {
	const url = page.url();
	if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) {
		throw new Error('Not signed in — log in in Chrome, then rerun');
	}
}

export interface StudioFlowResult {
	csvAbsolutePath: string;
}

export async function runStudioFlow(
	context: BrowserContext,
	outputCsvPath: string,
): Promise<StudioFlowResult> {
	const page = await context.newPage();
	try {
		await page.goto(STUDIO_URL, {waitUntil: 'networkidle'});
		await assertLoggedIn(page);
		await humanWait(600, 300);

		await page.goto(MEMBERSHIPS_URL, {waitUntil: 'networkidle'});
		await assertLoggedIn(page);
		await humanWait(600, 300);

		// Report generation, polling, and download land in Tasks 7 and 8.
		throw new Error('STUDIO_FLOW_NOT_IMPLEMENTED: stop here until Task 7');
	} finally {
		if (!page.isClosed()) await page.close();
	}

	// Unreachable until Task 8; kept so the type of the function is stable.
	// eslint-disable-next-line no-unreachable
	return {csvAbsolutePath: outputCsvPath};
}
```

- [ ] **Step 2: Call it from the entry point**

In `scripts/fetch-members.ts`:

Add import:
```ts
import {runStudioFlow} from './lib/studio-flow';
```

Replace the `try { ... }` block inside `main()` with:
```ts
try {
	const [context] = browser.contexts();
	if (!context) {
		throw new Error('no default browser context');
	}
	await runStudioFlow(context, OUTPUT_CSV);
	process.stdout.write(`wrote ${OUTPUT_CSV}\n`);
} finally {
	await browser.disconnect();
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 4: Manual verification — logged in**

Run: `npm run fetch-members`
Expected: Chrome opens the memberships page, then the script exits with `STUDIO_FLOW_NOT_IMPLEMENTED: stop here until Task 7`. Chrome stays open on the memberships page.

- [ ] **Step 5: Manual verification — logged out**

Sign out of YouTube in the Default profile, then:
Run: `npm run fetch-members`
Expected: script exits with `Not signed in — log in in Chrome, then rerun`. **Sign back in before the next task.**

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/studio-flow.ts scripts/fetch-members.ts
git commit -m "feat(scripts): navigate to Studio memberships and detect logged-out state"
```

---

## Task 7: Studio flow — discover selectors, click generate, poll for ready

**Files:**
- Modify: `scripts/lib/studio-flow.ts`

Context for the implementer: YouTube Studio's compiled class names rotate, so selectors are discovered by hand against the live UI. This task is two phases — a discovery phase driving the page interactively, and a coding phase baking the findings into `SELECTORS`.

- [ ] **Step 1: Discover the selectors interactively**

With Chrome already attached on the memberships page from the previous task's test, open the page in an interactive Playwright session — either via the Playwright MCP server in your coding environment, or `npx playwright codegen --target=javascript http://127.0.0.1:<port>` pointed at the existing CDP endpoint. Click through the real flow (open the export/download report dialog, fill in date range if required, submit), capturing for each control:
- The human-visible button text or label.
- The simplest Playwright locator that resolves it: prefer `getByRole('button', {name: /…/i})`, `getByText(...)`, `getByLabel(...)`. Fall back to `getByTestId` if present. Avoid raw CSS class selectors.

Also capture:
- Whether a date-range / format dialog appears and which fields it exposes.
- The locator for the row that represents the newly generated report (e.g., the top row of a reports table).
- The locator for the status cell inside that row and the exact text for the "ready" state (record the exact string — it may be localized, e.g. Thai).
- The locator for the download action on that row (icon button? context menu?).

Write these down in a scratch file; they are the inputs to Step 2.

- [ ] **Step 2: Add `SELECTORS` constant and `generateAndWait` helper**

Edit `scripts/lib/studio-flow.ts`. Add, near the top (under the URL constants):

```ts
// Fill these in from the discovery pass in Task 7 Step 1.
const SELECTORS = {
	openExportDialog: {role: 'button' as const, name: /export|download.*report|ดาวน์โหลด/i},
	confirmExport: {role: 'button' as const, name: /export|download|confirm|ตกลง/i},
	reportRows: 'tr[role="row"], ytcp-reports-table-row',
	rowStatusCell: '[data-status], .status, td:has-text("Ready"), td:has-text("Generating")',
	readyStatusText: /ready|พร้อม/i,
	rowDownloadButton: {role: 'button' as const, name: /download|ดาวน์โหลด/i},
};

const POLL_INTERVAL_MS = 4_000;
const POLL_JITTER_MS = 1_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;
```

**Important:** the values above are starting guesses. After Step 1 you must edit each field to match what you actually observed.

Add these imports at the top of the file, alongside the existing imports:

```ts
import type {Locator} from 'playwright-core';
import {humanClick, humanScroll, humanWait} from './humanize';
```

Then add the following helpers below `assertLoggedIn`:

```ts
async function openAndSubmitExportDialog(page: Page): Promise<void> {
	await humanScroll(page, 400);
	await humanWait(400, 200);

	const openBtn = page.getByRole(SELECTORS.openExportDialog.role, {
		name: SELECTORS.openExportDialog.name,
	});
	await openBtn.waitFor({state: 'visible', timeout: 15_000});
	await humanClick(page, openBtn);

	// If a dialog appears, accept defaults and submit. If it doesn't, this is a no-op
	// because the confirm locator won't resolve and the timeout fails us fast.
	const confirmBtn = page.getByRole(SELECTORS.confirmExport.role, {
		name: SELECTORS.confirmExport.name,
	});
	await confirmBtn.waitFor({state: 'visible', timeout: 15_000});
	await humanWait(500, 250);
	await humanClick(page, confirmBtn);
}

async function newestReportRow(page: Page): Promise<Locator> {
	const rows = page.locator(SELECTORS.reportRows);
	await rows.first().waitFor({state: 'visible', timeout: 30_000});
	return rows.first();
}

async function waitForReady(page: Page, row: Locator): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const statusText = (await row.locator(SELECTORS.rowStatusCell).innerText()).trim();
		if (SELECTORS.readyStatusText.test(statusText)) return;
		const wait = POLL_INTERVAL_MS + (Math.random() * 2 - 1) * POLL_JITTER_MS;
		await new Promise((r) => setTimeout(r, Math.max(1_000, Math.round(wait))));
	}
	throw new Error('Report not ready after 5min; retry later');
}
```

Wire them into `runStudioFlow` by replacing the `STUDIO_FLOW_NOT_IMPLEMENTED` throw with:
```ts
await openAndSubmitExportDialog(page);
const row = await newestReportRow(page);
await waitForReady(page, row);

throw new Error('STUDIO_FLOW_DOWNLOAD_PENDING: stop here until Task 8');
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 4: Manual verification**

Run: `npm run fetch-members`
Expected:
- Script navigates to memberships, clicks the export button (visible mouse movement), handles any dialog, and enters the polling loop.
- After the report finishes generating (can be seconds or minutes), the script exits with `STUDIO_FLOW_DOWNLOAD_PENDING: stop here until Task 8`.
- If the selectors are wrong, the script fails within ~15–30s with `UI changed; selectors in studio-flow.ts need updating` (see next step).

- [ ] **Step 5: Improve the UI-drift failure message**

At the top of `openAndSubmitExportDialog`, wrap the `waitFor` so selector misses turn into the spec's error message. Replace the `openBtn.waitFor(...)` line with:

```ts
try {
	await openBtn.waitFor({state: 'visible', timeout: 15_000});
} catch {
	throw new Error('UI changed; selectors in studio-flow.ts need updating');
}
```

Do the same around the `confirmBtn.waitFor(...)` call and around `newestReportRow`'s `rows.first().waitFor(...)`.

Run: `npm test`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/studio-flow.ts
git commit -m "feat(scripts): trigger Studio CSV export and poll for ready"
```

---

## Task 8: Studio flow — capture download and atomic write

**Files:**
- Modify: `scripts/lib/studio-flow.ts`

- [ ] **Step 1: Add download capture + atomic save**

Edit `scripts/lib/studio-flow.ts`:

Add import at the top:
```ts
import * as fs from 'node:fs/promises';
```

Add helper below `waitForReady`:
```ts
async function downloadNewestReport(
	page: Page,
	row: Locator,
	outputCsvPath: string,
): Promise<void> {
	const downloadBtn = row.getByRole(SELECTORS.rowDownloadButton.role, {
		name: SELECTORS.rowDownloadButton.name,
	});
	try {
		await downloadBtn.waitFor({state: 'visible', timeout: 15_000});
	} catch {
		throw new Error('UI changed; selectors in studio-flow.ts need updating');
	}

	const downloadPromise = page.waitForEvent('download', {timeout: 60_000});
	await humanClick(page, downloadBtn);
	let download;
	try {
		download = await downloadPromise;
	} catch {
		throw new Error('Download did not start; retry');
	}

	const tmp = `${outputCsvPath}.tmp`;
	await download.saveAs(tmp);
	await fs.rename(tmp, outputCsvPath);
}
```

Replace the `STUDIO_FLOW_DOWNLOAD_PENDING` throw in `runStudioFlow` with:
```ts
await downloadNewestReport(page, row, outputCsvPath);
```

Then, at the bottom of `runStudioFlow` (after the `finally` block, which already exists from Task 6), the function still has:
```ts
	// Unreachable until Task 8; kept so the type of the function is stable.
	// eslint-disable-next-line no-unreachable
	return {csvAbsolutePath: outputCsvPath};
```
Delete the two comment lines but keep the `return`. It is now reachable.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm test`
Expected: passes.

- [ ] **Step 3: End-to-end manual verification — happy path**

From a clean state (no stale CSV):
```bash
rm -f public/members.csv
npm run fetch-members
head -1 public/members.csv
```
Expected:
- Script runs end to end.
- Final stdout line: `wrote /Users/…/public/members.csv`.
- `head -1 public/members.csv` prints the header row matching `public/members.example.csv`'s columns (Member, Link to profile, Current level, Total time on level (months), Total time as member (months), Last update, Last update timestamp).

- [ ] **Step 4: End-to-end manual verification — Remotion consumes it**

Run: `npm start`
Expected: Remotion preview loads past the CSV loading spinner. Let it render a few seconds, confirm member names scroll.

- [ ] **Step 5: Verify no stale `.tmp` file**

Run: `ls public/members.csv.tmp 2>&1 || echo "no tmp"`
Expected: `no tmp`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/studio-flow.ts
git commit -m "feat(scripts): capture CSV download and atomically write to public/"
```

---

## Task 9: Final sweep — error-path verification

**Files:** none modified (this task verifies all paths work; adjusts only if a real bug is found).

- [ ] **Step 1: Verify `npm test` is clean**

Run: `npm test`
Expected: passes.

- [ ] **Step 2: Verify the CSV-output failure path**

Temporarily make `public/` read-only:
```bash
chmod -w public
npm run fetch-members; echo "exit=$?"
chmod +w public
```
Expected: script exits non-zero with a message that includes `EACCES` or similar. (Does NOT leave a half-written CSV — atomic write rolls back on rename failure, and Playwright's `saveAs` would have failed first.)

- [ ] **Step 3: Verify the not-signed-in failure path**

If you tested this in Task 6 and the behavior was correct, skip. Otherwise: sign out of YouTube in the Default profile, run `npm run fetch-members`, observe `Not signed in — log in in Chrome, then rerun`, sign back in.

- [ ] **Step 4: Commit any fixes only if Step 2 or Step 3 surfaced a real bug**

If no fixes are needed, skip.

---

## Out of scope (explicitly not in this plan)

- Retry loops, report reuse, historical snapshots — spec §Goals & non-goals.
- CI execution, headless mode — spec §Non-goals.
- Chaining into `npm run build` — spec §Non-goals.
- Unit-test infrastructure — spec §Testing.
- Non-macOS support — spec assumes macOS throughout.
