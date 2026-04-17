import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);

// The folder ID is the "1abc...xyz" segment of a Drive folder URL:
// drive.google.com/drive/folders/<id>
const GDRIVE_FOLDER_ID = '1grF18AoeRkvjXR46VWpBOt_1omyYPSOn';
// gog account selector; matches one of the identities added via `gog auth add`.
const GOG_ACCOUNT = 'thananon@9arm.co';
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
	// --account selects the identity to use; matches gog auth add <email>.
	// The flag is a top-level option that precedes the subcommand.
	const allArgs = ['--account', GOG_ACCOUNT, ...args];
	try {
		const {stdout} = await execFileP('gog', allArgs);
		return stdout;
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {stderr?: string};
		if (e.code === 'ENOENT') {
			die('gog CLI not found on PATH. Install with: brew install gogcli');
		}
		const stderr = e.stderr ?? '';
		die(`gog ${args.slice(0, 2).join(' ')} failed:\n${stderr.trim() || e.message}`);
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
		// Upload reached Drive but we can't print a clickable URL. Exit non-zero
		// so `npm run publish` and any CI pipeline treats this as a partial
		// failure instead of silently succeeding without the user-facing URL.
		process.stderr.write(
			'upload succeeded but could not extract file ID from gog output:\n' +
				uploadOut +
				'\n',
		);
		process.exit(1);
	}
	process.stdout.write(
		`uploaded. https://drive.google.com/file/d/${uploadedId}/view\n`,
	);
}

main().catch((err) => {
	die(err instanceof Error ? err.message : String(err));
});
