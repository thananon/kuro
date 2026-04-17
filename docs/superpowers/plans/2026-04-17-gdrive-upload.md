# Google Drive upload — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `npm run upload` (uploads the rendered MP4 to Drive) and `npm run publish` (renders + uploads). The uploader is a thin TypeScript wrapper around the `gog` CLI that finds any existing `CreditRoll.mp4` in the configured Drive folder and replaces it in place, preserving the shared link.

**Architecture:** Single-file TypeScript entry point (`scripts/upload.ts`) run via `tsx`. It shells out to `gog drive ls --json` to find the existing file, then `gog drive upload --replace <id>` (or `--parent <id>` for first upload). Target folder is a hardcoded constant in the script that the user edits once.

**Tech Stack:** TypeScript, `tsx` (zero-config TS runner), `@types/node`, the external `gog` CLI (`brew install gogcli`). No new Playwright / browser dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-17-gdrive-upload-design.md`

**Per-project note on testing:** This repo has no test runner — `npm test` is lint + typecheck only (see `CLAUDE.md`). The design spec explicitly chose not to add one. Each task verifies via (a) `npm test` and (b) a manual run step. Strict unit-test TDD is not applied.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/upload.ts` | Full script: preflight → find existing file in folder → upload or replace → print URL |
| `scripts/tsconfig.json` | Isolated TS config so `tsc` can typecheck `scripts/*.ts` against Node types without polluting the Remotion root config |
| `package.json` | Add `upload` + `publish` npm scripts; add `tsx` + `@types/node` dev deps; extend `test` script |
| `tsconfig.json` | Add `"exclude": ["scripts", "node_modules", "dist", "out"]` so root `tsc` ignores `scripts/` |

---

## Task 1: Scaffold `scripts/`, deps, tsconfig, npm wiring

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `scripts/tsconfig.json`
- Create: `scripts/upload.ts` (placeholder — Task 2 fills in)

- [ ] **Step 1: Install dev dependencies**

Run:
```bash
npm install --save-dev tsx@^4.21.0 @types/node@^25.6.0
```

Expected: both packages added to `devDependencies`; no vulnerabilities.

- [ ] **Step 2: Update `package.json` scripts block**

The scripts block must read exactly:
```json
"scripts": {
  "start": "remotion preview src/index.tsx",
  "build": "remotion render src/index.tsx CreditRoll out/CreditRoll.mp4",
  "upgrade": "remotion upgrade",
  "test": "eslint src --ext ts,tsx,js,jsx && tsc && tsc -p scripts/tsconfig.json",
  "upload": "tsx scripts/upload.ts",
  "publish": "npm run build && npm run upload"
}
```

Preserve the repo's tab-indented JSON style in `package.json`.

- [ ] **Step 3: Add `exclude` to root `tsconfig.json`**

Edit `/Users/tpatinya/kuro/tsconfig.json`. After the `compilerOptions` object, add a sibling `"exclude"` key. The final file should be:
```json
{
	"compilerOptions": {
		"target": "ES2018",
		"module": "commonjs",
		"jsx": "react-jsx",
		"outDir": "./dist",
		"strict": true,
		"noEmit": true,
		"lib": ["es2015"],
		"types": ["web", "react"],
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true
	},
	"exclude": ["scripts", "node_modules", "dist", "out"]
}
```

Why: without this, root `tsc` walks into `scripts/*.ts` and tries to compile them against the Remotion-only lib (`["es2015"]`), which breaks the moment the script uses a Node builtin. The `scripts/tsconfig.json` from Step 4 picks them up with the right config.

- [ ] **Step 4: Create `scripts/tsconfig.json`**

Exact content:
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
    "resolveJsonModule": true,
    "ignoreDeprecations": "6.0"
  },
  "include": ["./**/*.ts"]
}
```

The `ignoreDeprecations` suppresses a TypeScript 6.0 warning about `"module": "commonjs"`; the value is unchanged but TS 6 flags it pending TS 7 removal.

- [ ] **Step 5: Create placeholder `scripts/upload.ts`**

Exact content:
```ts
// Placeholder. Real implementation lands in Task 2.
export {};
```

- [ ] **Step 6: Verify `npm test` passes**

Run:
```bash
npm test
```

Expected: lint clean; root `tsc` succeeds; `tsc -p scripts/tsconfig.json` succeeds; exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json scripts/tsconfig.json scripts/upload.ts
git commit -m "chore: scaffold scripts/ for Google Drive uploader"
```

---

## Task 2: Implement `scripts/upload.ts`

**Files:**
- Modify: `scripts/upload.ts`

- [ ] **Step 1: Replace placeholder with full implementation**

Full content of `scripts/upload.ts`:
```ts
import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);

// Edit this once you have the target Drive folder's ID. The ID is the
// "1abc...xyz" segment in a folder URL: drive.google.com/drive/folders/<id>
const GDRIVE_FOLDER_ID = 'TODO_FILL_IN';
const DRIVE_FILENAME = 'CreditRoll.mp4';
const LOCAL_PATH = path.join(process.cwd(), 'out', 'CreditRoll.mp4');

function die(msg: string): never {
	process.stderr.write(msg + '\n');
	process.exit(1);
}

interface DriveFile {
	id: string;
	name: string;
}

async function gog(args: string[]): Promise<string> {
	try {
		const {stdout} = await execFileP('gog', args);
		return stdout;
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {stderr?: string};
		if (e.code === 'ENOENT') {
			die('gog CLI not found on PATH. Install with: brew install gogcli');
		}
		const stderr = e.stderr ?? '';
		die(`gog ${args[0]} ${args[1]} failed:\n${stderr.trim() || e.message}`);
	}
}

/**
 * Parse gog's --json ls output. The exact top-level shape (array vs
 * {files: [...]}) is not documented in the gog README, so accept both.
 */
function parseListOutput(raw: string): DriveFile[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		die(`Could not parse gog output as JSON:\n${raw}`);
	}
	const arr = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === 'object' && 'files' in parsed
			? (parsed as {files: unknown}).files
			: parsed && typeof parsed === 'object' && 'items' in parsed
				? (parsed as {items: unknown}).items
				: null;
	if (!Array.isArray(arr)) {
		die(`Unexpected gog ls output shape:\n${raw}`);
	}
	return arr.filter(
		(x): x is DriveFile =>
			!!x &&
			typeof x === 'object' &&
			typeof (x as Record<string, unknown>).id === 'string' &&
			typeof (x as Record<string, unknown>).name === 'string',
	);
}

function extractUploadedId(raw: string): string | null {
	// gog --json upload output shape isn't documented either; try JSON first,
	// then fall back to scraping a Drive file ID pattern from any text output.
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.id === 'string') return parsed.id;
	} catch {
		// not JSON
	}
	const m = raw.match(/[-\w]{25,}/);
	return m ? m[0] : null;
}

async function main(): Promise<void> {
	if (!fs.existsSync(LOCAL_PATH)) {
		die(`Run npm run build first; ${LOCAL_PATH} is missing`);
	}
	if (GDRIVE_FOLDER_ID === 'TODO_FILL_IN') {
		die(
			'Edit scripts/upload.ts and set GDRIVE_FOLDER_ID to your target Drive folder ID',
		);
	}

	process.stdout.write(`searching folder ${GDRIVE_FOLDER_ID} for ${DRIVE_FILENAME}...\n`);
	const lsOut = await gog([
		'drive',
		'ls',
		'--parent',
		GDRIVE_FOLDER_ID,
		'--max',
		'1000',
		'--json',
	]);
	const files = parseListOutput(lsOut);
	const matches = files.filter((f) => f.name === DRIVE_FILENAME);
	if (matches.length > 1) {
		die(
			`Multiple files named ${DRIVE_FILENAME} in target folder; resolve manually:\n` +
				matches.map((m) => `  ${m.id}`).join('\n'),
		);
	}

	let uploadOut: string;
	let uploadedId: string | null = null;
	if (matches.length === 1) {
		const existing = matches[0];
		process.stdout.write(`replacing existing file ${existing.id}...\n`);
		uploadOut = await gog([
			'drive',
			'upload',
			LOCAL_PATH,
			'--replace',
			existing.id,
			'--json',
		]);
		uploadedId = extractUploadedId(uploadOut) ?? existing.id;
	} else {
		process.stdout.write('no existing file found; uploading fresh...\n');
		uploadOut = await gog([
			'drive',
			'upload',
			LOCAL_PATH,
			'--parent',
			GDRIVE_FOLDER_ID,
			'--json',
		]);
		uploadedId = extractUploadedId(uploadOut);
	}

	if (!uploadedId) {
		process.stderr.write(
			'upload succeeded but could not extract file ID from gog output:\n' +
				uploadOut +
				'\n',
		);
		process.exit(0);
	}
	process.stdout.write(
		`uploaded. https://drive.google.com/file/d/${uploadedId}/view\n`,
	);
}

main().catch((err) => {
	die(err instanceof Error ? err.message : String(err));
});
```

- [ ] **Step 2: Verify typecheck passes**

Run:
```bash
npm test
```

Expected: lint + both tsc invocations pass.

- [ ] **Step 3: Verify the unconfigured-folder failure path**

With `GDRIVE_FOLDER_ID` still equal to `'TODO_FILL_IN'`:
Run:
```bash
npm run upload
```

Expected: stderr contains `Edit scripts/upload.ts and set GDRIVE_FOLDER_ID to your target Drive folder ID`; exit code 1.

- [ ] **Step 4: Verify the missing-file failure path**

With `GDRIVE_FOLDER_ID` temporarily set to a non-placeholder value (any string other than `TODO_FILL_IN` — e.g. replace `'TODO_FILL_IN'` with `'sentinel-not-a-real-id'`) and no `out/CreditRoll.mp4` present:
```bash
rm -f out/CreditRoll.mp4
npm run upload
```

Expected: stderr contains `Run npm run build first; ...CreditRoll.mp4 is missing`; exit code 1.

Then revert the constant back to `'TODO_FILL_IN'` — real folder ID comes in Task 3.

- [ ] **Step 5: Commit**

```bash
git add scripts/upload.ts
git commit -m "feat(scripts): upload out/CreditRoll.mp4 to Google Drive via gog"
```

---

## Task 3: End-to-end verification with a real folder ID

This task is gated on two things only the operator can provide:
- the target Drive folder's real ID
- `gog` installed and authenticated against an account with write access to that folder

**Files:**
- Modify: `scripts/upload.ts` (one-line edit to `GDRIVE_FOLDER_ID`)

- [ ] **Step 1: Verify gog is installed and authenticated**

Run:
```bash
gog --version
gog auth list
```

Expected: version string prints; the `auth list` output shows at least one account. If either fails, follow the gog README to install (`brew install gogcli`) and authenticate (`gog auth credentials …` + `gog auth add …`) before continuing.

- [ ] **Step 2: Fill in the real folder ID**

Open `scripts/upload.ts`. Replace the placeholder:
```ts
const GDRIVE_FOLDER_ID = 'TODO_FILL_IN';
```
with the actual folder ID (copy it from the folder's Drive URL — it's the segment after `/folders/`). Example:
```ts
const GDRIVE_FOLDER_ID = '1abcDEFghiJKLmnoPQRstuVWX';
```

- [ ] **Step 3: Render the video**

Run:
```bash
npm run build
```

Expected: `out/CreditRoll.mp4` exists afterwards. (Requires `public/members.csv`; if missing, copy from `public/members.example.csv` per `CLAUDE.md` before running.)

- [ ] **Step 4: First upload (new file)**

Run:
```bash
npm run upload
```

Expected output (order matters, IDs will differ):
```
searching folder <your-id> for CreditRoll.mp4...
no existing file found; uploading fresh...
uploaded. https://drive.google.com/file/d/<id>/view
```

Open the printed URL in a browser. Confirm the video plays and lives in the expected folder.

- [ ] **Step 5: Second upload (replace in place)**

Without modifying anything else, run:
```bash
npm run upload
```

Expected output:
```
searching folder <your-id> for CreditRoll.mp4...
replacing existing file <id>...
uploaded. https://drive.google.com/file/d/<same-id>/view
```

The file ID in the URL must match Step 4's URL — `--replace` preserves the file's identity (and thus any shared links).

- [ ] **Step 6: Verify `npm run publish` chains build + upload**

Run:
```bash
npm run publish
```

Expected: Remotion build runs (visible progress), then the upload runs with the same "replacing existing file" path as Step 5. Same file ID at the end.

- [ ] **Step 7: Commit the real folder ID**

```bash
git add scripts/upload.ts
git commit -m "chore: set GDRIVE_FOLDER_ID for the members credits folder"
```

(If the folder is sensitive — e.g. contains unpublished material — stop here and instead leave the placeholder + note to revisit the "env var" option in the spec. In that case, skip this commit and re-open the design decision with the spec author.)

---

## Out of scope (explicitly not in this plan)

- Multi-file upload, batch operations — spec §Non-goals.
- Timestamped / versioned filenames on Drive — spec §Non-goals.
- Progress bars / streaming feedback — spec §Non-goals.
- OAuth setup for `gog` — delegated to `gog auth` per spec §Non-goals.
- Upload retries — delegated to gog per spec §Non-goals.
- Concurrent-run protection — spec §Non-goals.
