import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);

// Channel memberships URL for this project's channel.
const STUDIO_URL =
	'https://studio.youtube.com/channel/UCoiEtD4v1qMAqHV5MDI5Qpg/monetization/memberships';

const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const OUTPUT_CSV = path.join(process.cwd(), 'public', 'members.csv');

// Upper bounds before we fail fast.
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const EXPORT_READY_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_APPEAR_TIMEOUT_MS = 60_000;

function die(msg: string): never {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

async function osa(script: string): Promise<string> {
	try {
		const {stdout} = await execFileP('osascript', ['-e', script]);
		return stdout.trim();
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {stderr?: string; stdout?: string};
		const msg = (e.stderr || e.stdout || e.message).trim();
		if (msg.includes('Executing JavaScript through AppleScript is turned off')) {
			die(
				'Chrome refuses JS injection: enable View → Developer → Allow JavaScript from Apple Events, then rerun.',
			);
		}
		if (msg.includes('not authorized to send Apple events')) {
			die(
				'macOS blocked Apple events: grant Terminal (or your shell) "Automation" permission for Google Chrome in System Settings → Privacy & Security.',
			);
		}
		throw new Error(`osascript failed: ${msg}`);
	}
}

/**
 * Run JS inside Chrome's active tab and return its result as a string.
 * AppleScript can only marshal primitives out, so the caller should JSON.stringify
 * any structured return and JSON.parse on this side.
 */
async function runJS(js: string): Promise<string> {
	// Escape double quotes and backslashes for embedding in AppleScript.
	const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return osa(
		`tell application "Google Chrome" to execute front window's active tab javascript "${escaped}"`,
	);
}

async function isChromeRunning(): Promise<boolean> {
	try {
		await execFileP('pgrep', ['-x', 'Google Chrome']);
		return true;
	} catch {
		return false;
	}
}

/**
 * Start Chrome if it's not running and wait for it to become scriptable.
 * Returns whether we launched it (true = cold start) or it was already up.
 */
async function ensureChromeRunning(): Promise<{launched: boolean}> {
	if (await isChromeRunning()) {
		await osa(`tell application "Google Chrome" to activate`);
		return {launched: false};
	}
	process.stdout.write('starting Chrome...\n');
	await execFileP('open', ['-a', 'Google Chrome']);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			await osa('tell application "Google Chrome" to count windows');
			await osa(`tell application "Google Chrome" to activate`);
			return {launched: true};
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	die('Chrome did not become scriptable within 15s of launch.');
}

/**
 * Open a tab at the memberships URL. On cold start (we just launched Chrome),
 * reuses the lone blank "new tab" Chrome opens by default so we don't leave
 * an empty tab behind — closing our tab then closes Chrome cleanly. On warm
 * start, always opens a new tab so nothing the user already had is touched.
 * Returns the tab's AppleScript id.
 */
async function openOwnedStudioTab(reuseLoneBlankTab: boolean): Promise<number> {
	const reuseBlock = reuseLoneBlankTab
		? `
	if (count of tabs of w) = 1 then
		set t to tab 1 of w
		set u to URL of t
		if u is "chrome://newtab/" or u is "chrome://new-tab-page/" or u is "about:blank" or u is "" then
			set URL of t to "${STUDIO_URL}"
			set active tab index of w to 1
			return id of t
		end if
	end if`
		: '';
	const out = await osa(`
tell application "Google Chrome"
	if (count of windows) = 0 then
		make new window
	end if
	set w to front window${reuseBlock}
	set newTab to make new tab at end of tabs of w with properties {URL:"${STUDIO_URL}"}
	set active tab index of w to (count of tabs of w)
	return id of newTab
end tell
`);
	const id = Number.parseInt(out, 10);
	if (!Number.isFinite(id)) die(`unexpected tab id from Chrome: ${out}`);
	return id;
}

/**
 * Close exactly the tab we opened. Safe if the tab is already gone.
 * Uses a `whose` filter because Chrome's AppleScript comparison of `id of t`
 * inside a manual repeat loop silently misses matches — only `whose id is X`
 * matches reliably.
 */
async function closeTabById(id: number): Promise<void> {
	await osa(`
tell application "Google Chrome"
	repeat with w in windows
		try
			set t to first tab of w whose id is ${id}
			close t
			return "closed"
		end try
	end repeat
	return "not found"
end tell
`);
}

async function waitFor(
	pred: () => Promise<boolean>,
	timeoutMs: number,
	pollMs: number,
	onTimeout: string,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	die(onTimeout);
}

/**
 * Detects login by checking the final URL after any redirect.
 */
async function assertLoggedIn(): Promise<void> {
	const url = await osa(
		`tell application "Google Chrome" to get URL of active tab of front window`,
	);
	if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) {
		die('Not signed in — sign in to YouTube Studio in Chrome, then rerun.');
	}
}

/**
 * Wait until a specific button (matched by tag + either aria-label or textContent)
 * is present anywhere in the document, including inside shadow roots.
 */
async function waitForButton(
	tag: string,
	label: string,
	labelAttr: 'aria-label' | 'textContent',
	timeoutMs: number,
	onTimeout: string,
): Promise<void> {
	const expr =
		labelAttr === 'aria-label'
			? `(el.getAttribute('aria-label') || '') === ${JSON.stringify(label)}`
			: `(el.textContent || '').trim() === ${JSON.stringify(label)}`;
	await waitFor(
		async () => {
			const out = await runJS(`
				(function() {
					if (document.readyState !== 'complete') return 'loading';
					function find(root, pred) {
						const q = [root];
						while (q.length) {
							const r = q.shift();
							const nodes = r.querySelectorAll('*');
							for (const el of nodes) {
								if (pred(el)) return el;
								if (el.shadowRoot) q.push(el.shadowRoot);
							}
						}
						return null;
					}
					const btn = find(document, el =>
						el.tagName === ${JSON.stringify(tag.toUpperCase())} &&
						${expr}
					);
					return btn ? 'ready' : 'missing';
				})()
			`);
			return out === 'ready';
		},
		timeoutMs,
		500,
		onTimeout,
	);
}

async function getCurrentBannerText(): Promise<string> {
	const out = await runJS(`
		(function() {
			function find(root, pred) {
				const q = [root];
				while (q.length) {
					const r = q.shift();
					const nodes = r.querySelectorAll('*');
					for (const el of nodes) {
						if (pred(el)) return el;
						if (el.shadowRoot) q.push(el.shadowRoot);
					}
				}
				return null;
			}
			const el = find(document, n =>
				n.tagName === 'DIV' &&
				/Your export started on/.test(n.textContent || '') &&
				(n.textContent || '').length < 200
			);
			return el ? el.textContent.trim() : '';
		})()
	`);
	return out;
}

/**
 * Click a button matching either aria-label OR textContent, across any of the
 * provided tag names (tried in order). Retries on "not found" to absorb the
 * brief windows where Studio re-renders and the element is momentarily gone.
 */
async function clickByLabel(
	tags: string[],
	label: string,
): Promise<void> {
	const js = `
		(function() {
			function find(root, pred) {
				const q = [root];
				while (q.length) {
					const r = q.shift();
					const nodes = r.querySelectorAll('*');
					for (const el of nodes) {
						if (pred(el)) return el;
						if (el.shadowRoot) q.push(el.shadowRoot);
					}
				}
				return null;
			}
			const tags = ${JSON.stringify(tags.map((t) => t.toUpperCase()))};
			const label = ${JSON.stringify(label)};
			const btn = find(document, el => {
				if (!tags.includes(el.tagName)) return false;
				const aria = el.getAttribute('aria-label') || '';
				const text = (el.textContent || '').trim();
				return aria === label || text === label;
			});
			if (!btn) return 'not found';
			btn.click();
			return 'clicked';
		})()
	`;
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const out = await runJS(js);
		if (out === 'clicked') return;
		await new Promise((r) => setTimeout(r, 400));
	}
	die(`UI changed: could not click "${label}" on tags ${tags.join('/')} after 10s.`);
}

async function snapshotDownloads(): Promise<Set<string>> {
	try {
		const entries = await fsp.readdir(DOWNLOADS_DIR);
		return new Set(entries);
	} catch {
		return new Set();
	}
}

async function waitForNewMembersCsv(before: Set<string>): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < DOWNLOAD_APPEAR_TIMEOUT_MS) {
		const now = await fsp.readdir(DOWNLOADS_DIR);
		// Match Studio's naming: "Your members <date> 9arm[.csv | (N).csv]", ignore .crdownload in-flight.
		const candidates = now
			.filter((n) => !before.has(n))
			.filter((n) => /^Your members .*\.csv$/.test(n))
			.map((n) => path.join(DOWNLOADS_DIR, n));
		if (candidates.length > 0) {
			// Pick the most recently modified one.
			const withStats = await Promise.all(
				candidates.map(async (p) => ({p, mtime: (await fsp.stat(p)).mtimeMs})),
			);
			withStats.sort((a, b) => b.mtime - a.mtime);
			return withStats[0].p;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	die(`Download did not appear in ${DOWNLOADS_DIR} within 60s.`);
}

async function main(): Promise<void> {
	if (process.platform !== 'darwin') {
		die('This script is macOS-only (depends on osascript).');
	}
	if (!fs.existsSync(path.dirname(OUTPUT_CSV))) {
		die(`public/ directory not found at ${path.dirname(OUTPUT_CSV)}`);
	}

	const {launched} = await ensureChromeRunning();

	process.stdout.write(
		launched
			? 'reusing cold-start blank tab for Studio...\n'
			: 'opening a dedicated Studio tab...\n',
	);
	const tabId = await openOwnedStudioTab(launched);

	try {
		process.stdout.write('waiting for Studio overview to load...\n');
		await assertLoggedIn();
		await waitForButton(
			'button',
			'See your members',
			'aria-label',
			PAGE_LOAD_TIMEOUT_MS,
			'Studio memberships overview did not become interactive within 30s — UI may have changed or you may not be signed in.',
		);
		await assertLoggedIn();

		process.stdout.write('opening member list drawer...\n');
		await clickByLabel(['button', 'ytcp-button'], 'See your members');

		process.stdout.write('waiting for member list to expose the Export control...\n');
		await waitForButton(
			'ytcp-icon-button',
			'Export all members to CSV file',
			'aria-label',
			PAGE_LOAD_TIMEOUT_MS,
			'Export control did not appear within 30s — UI may have changed.',
		);

		const priorBanner = await getCurrentBannerText();
		if (priorBanner) {
			process.stdout.write(`existing export banner: "${priorBanner}"\n`);
		}

		process.stdout.write('clicking "Export all members to CSV file"...\n');
		await clickByLabel(['ytcp-icon-button'], 'Export all members to CSV file');

		process.stdout.write('waiting for fresh export to be ready (up to 5 min)...\n');
		await waitFor(
			async () => {
				const t = await getCurrentBannerText();
				return !!t && t !== priorBanner && /is ready for download/.test(t);
			},
			EXPORT_READY_TIMEOUT_MS,
			4000,
			'Export not ready after 5 minutes — retry later.',
		);

		const before = await snapshotDownloads();

		process.stdout.write('clicking Download...\n');
		await clickByLabel(['button', 'ytcp-button'], 'Download');

		const downloaded = await waitForNewMembersCsv(before);
		process.stdout.write(`downloaded: ${downloaded}\n`);

		const tmp = OUTPUT_CSV + '.tmp';
		await fsp.copyFile(downloaded, tmp);
		await fsp.rename(tmp, OUTPUT_CSV);
		await fsp.unlink(downloaded).catch(() => undefined);
		process.stdout.write(`wrote ${OUTPUT_CSV}\n`);
	} finally {
		await closeTabById(tabId).catch(() => undefined);
	}
}

main().catch((err) => {
	die(err instanceof Error ? err.message : String(err));
});
