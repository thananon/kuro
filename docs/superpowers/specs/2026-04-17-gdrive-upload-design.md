# Upload `out/CreditRoll.mp4` to Google Drive — design

**Date:** 2026-04-17
**Status:** approved for implementation planning

## Purpose

After `npm run build` renders `out/CreditRoll.mp4`, the file needs to land in a specific Google Drive folder so it can be shared. Today that's a manual drag-and-drop. This spec covers a local script that uploads the rendered video, replacing any existing file of the same name in the target folder while preserving its shared link.

## Goals & non-goals

**Goals**
- `npm run upload` uploads `out/CreditRoll.mp4` into a fixed Drive folder.
- `npm run publish` renders first (`npm run build`), then uploads.
- If a file named `CreditRoll.mp4` already exists in the target folder, replace its content in place (shared link preserved).
- Fail fast with clear messages on missing input, unconfigured folder, unauthenticated gog, network errors.

**Non-goals**
- Multi-file upload. One fixed file.
- Timestamped / versioned filenames on Drive.
- Progress bars / streaming feedback.
- OAuth setup — delegated entirely to `gog auth` commands the user runs once.
- Upload retry / resumable upload logic — delegated to gog.
- Race protection against concurrent invocations.

## Decisions locked in during brainstorming

1. **Tool:** [`gog`](https://github.com/steipete/gogcli) (`brew install gogcli`), a CLI wrapper over Google APIs. Has native `drive upload --replace <fileId>` for in-place content replacement preserving shared links.
2. **Stack:** TypeScript + `tsx`, matching the existing `scripts/` convention introduced by (and abandoned on) `feat/members-scraper`. Shell would have been ~15 lines but we keep the Node pattern for consistency.
3. **Target folder ID:** Hardcoded constant at the top of the script; user edits once when they know the ID.
4. **Filename collision:** Always replace by name. Drive allows duplicate names per folder; we avoid making duplicates by finding the existing file and using `--replace`.
5. **Error policy:** Fail fast. Non-zero exit, single-line stderr. No retries.
6. **Auth:** Delegated to `gog` — script doesn't configure OAuth. If gog isn't authenticated, `gog drive ls` will fail with its own error, which we propagate.

## Architecture

```
scripts/
  upload.ts            # entry point
  tsconfig.json        # reused from the abandoned scratch scraper pattern (or added here)
```

Single file. No library modules — the entire script fits in one readable TS file.

## Script flow

1. **Constants**
   ```ts
   const GDRIVE_FOLDER_ID = 'TODO_FILL_IN';
   const DRIVE_FILENAME = 'CreditRoll.mp4';
   const LOCAL_PATH = 'out/CreditRoll.mp4';
   ```

2. **Preflight**
   - `fs.existsSync(LOCAL_PATH)` — if false, die with `Run npm run build first; out/CreditRoll.mp4 is missing`.
   - ~~`GDRIVE_FOLDER_ID !== 'TODO_FILL_IN'` — if false, die with `Edit scripts/upload.ts and set GDRIVE_FOLDER_ID to your target Drive folder ID`.~~ Dropped during Task 3 once the real folder ID was committed to the script; with the constant always holding a real ID, the guard was unreachable and removed. Restore this check if you ever reset the constant to a placeholder for testing.
   - Do preflight `gog` binary presence via the `ENOENT` catch in `gog()` — it emits `gog CLI not found on PATH. Install with: brew install gogcli` instead of Node's raw spawn error. The earlier spec note that said "don't preflight" proved to give a less readable error in practice; the implementation deviated for the better.

3. **Find existing file**
   - Run `gog drive ls --parent <GDRIVE_FOLDER_ID> --max 1000 --json` (gog's default output mode is JSON-first per its README; `--json` may or may not be a flag — if it's default, drop it).
   - Parse JSON, find first entry where `name === 'CreditRoll.mp4'`. Capture its `id`.
   - If more than one matching entry exists: die with `Multiple files named CreditRoll.mp4 in target folder; resolve manually`.

4. **Upload**
   - If a match was found: `gog drive upload out/CreditRoll.mp4 --replace <fileId>`.
   - If no match: `gog drive upload out/CreditRoll.mp4 --parent <GDRIVE_FOLDER_ID>`.
   - Propagate gog's stderr verbatim on non-zero exit.

5. **Print Drive URL**
   - After a successful upload, parse the uploaded file's ID (from gog's stdout) and print `https://drive.google.com/file/d/<id>/view` so the user can click straight to it in terminal emulators that make URLs clickable.

## Failure modes

| Condition | Message |
|---|---|
| `out/CreditRoll.mp4` missing | `Run npm run build first; out/CreditRoll.mp4 is missing` |
| `GDRIVE_FOLDER_ID` still placeholder | `Edit scripts/upload.ts and set GDRIVE_FOLDER_ID to your target Drive folder ID` |
| `gog` not installed (`ENOENT`) | Propagate Node's spawn error |
| `gog` not authenticated | Propagate gog's stderr |
| Network / API errors | Propagate gog's stderr |
| Multiple same-named files in folder | `Multiple files named CreditRoll.mp4 in target folder; resolve manually` |
| JSON parse fails | Print the offending gog output + fail with `Could not parse gog output` |

## Integration

**`package.json` additions:**
```json
"scripts": {
  "upload": "tsx scripts/upload.ts",
  "publish": "npm run build && npm run upload"
}
```

**New dev dependencies:** `tsx` (runner), `@types/node` (for Node builtins in the script). Same versions the abandoned scraper branch used: `tsx@^4.21.0`, `@types/node@^25.6.0`.

**New files:** `scripts/upload.ts`, `scripts/tsconfig.json` (isolated config so the Remotion root `tsc` doesn't try to compile `scripts/`).

**Modified files:** `package.json` (two scripts + two deps), root `tsconfig.json` (add `"exclude": ["scripts", ...]`).

**No changes to:** `src/`, `remotion.config.ts`, the Remotion bundle.

## Testing

This repo has no test runner — `npm test` is lint + typecheck only (see `CLAUDE.md`). This spec does not add one. Verification is manual and staged:

1. `npm test` passes after the changes (lint + both tsc invocations).
2. With `GDRIVE_FOLDER_ID` still `TODO_FILL_IN`: `npm run upload` exits 1 with the "edit scripts/upload.ts" message.
3. With `GDRIVE_FOLDER_ID` set and `out/CreditRoll.mp4` absent: exits 1 with the "run npm run build" message.
4. With both conditions fixed and gog authenticated: first run uploads as new; second run replaces in place; the Drive link is stable across runs.
