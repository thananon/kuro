# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — Remotion preview server for `src/index.tsx`.
- `npm run build` — Renders the `CreditRoll` composition to `out/CreditRoll.mp4`.
- `npm test` — ESLint over `src` + `tsc` for the Remotion project + `tsc -p scripts/tsconfig.json` for the Drive uploader. All three must pass; there are no unit tests.
- `npm run upgrade` — `remotion upgrade` (Remotion's version bumper).
- `npm run upload` — Uploads the already-built `out/CreditRoll.mp4` to the Drive folder configured in `scripts/upload.ts`. Finds any existing `CreditRoll.mp4` in the folder and replaces its content in place via `gog drive upload --replace`, preserving the shared link. Requires `gog` installed and authenticated (see below). Fails fast with `Run npm run build first` if the MP4 isn't there.
- `npm run publish` — Chains `npm run build && npm run upload`.
- `npm run fetch-members` — Refreshes `public/members.csv` by driving the user's real Chrome via AppleScript + injected JS (no CDP, no scratch profile, no automation flag). Clicks Studio's "See your members" → "Export all members to CSV file" → polls for the "ready" banner → clicks Download → moves the new CSV from `~/Downloads/` into `public/members.csv` atomically. Requires the one-time Chrome setup below.

There is no single-test runner because there is no test suite — `npm test` is lint + typecheck only.

## Required local assets (gitignored)

Before `npm start` or `npm run build` will work end-to-end:

1. `public/members.csv` — copy from `public/members.example.csv`. Loaded at runtime via `staticFile('/members.csv')` and parsed with PapaParse inside `CreditRoll.tsx`. The CSV is wrapped in `delayRender`/`continueRender`, so a missing or malformed file manifests as the preview hanging on the loading spinner rather than a clear error.
2. `public/images/example.gif` — per README. The actual credit roll references `HOME.gif`, `EAT-EAT.gif`, and `COFFEE.gif` under `public/images/` via `staticFile(...)`; those are committed.

## Required local tooling (for `npm run upload` / `npm run publish`)

`gog` CLI — `brew install gogcli`, then authenticate once:
```
gog auth credentials ~/path/to/client_secret.json
gog auth add thananon@9arm.co
```
The script passes `--account thananon@9arm.co` on every gog call (value of `GOG_ACCOUNT` in `scripts/upload.ts`). If you change accounts, update that constant — there's no env var indirection.

## One-time Chrome setup (for `npm run fetch-members`)

The members scraper drives your actual Chrome via AppleScript. Two one-time toggles are required:

1. **Chrome → View → Developer → Allow JavaScript from Apple Events** (off by default since Chrome 71). Without this, AppleScript's `execute javascript` fails and the script tells you exactly what to enable.
2. **Chrome → Settings → Downloads → Ask where to save each file before downloading — OFF.** With it on, every download triggers a native macOS save dialog that would block the script. Default location should be `~/Downloads/`.

macOS will also prompt once for Automation permission the first time the script tries to control Chrome — approve it in System Settings → Privacy & Security → Automation.

Why this approach is safer than the earlier attempts: this uses your real Chrome binary and real default profile — no `--remote-debugging-port` (Chrome blocks it on the default profile), no scratch profile login (Google's risk engine blocks fresh-profile logins), no cookie transplant (Google invalidates transplanted sessions as theft). AppleScript's JS injection goes through Chrome's own internal hook, so from Google's server perspective, every request looks identical to a human clicking.

## Scheduled publish (Saturday 00:00)

A LaunchAgent runs `npm run publish` every Saturday at midnight local time. Install once:

```
scripts/install-launchd.sh
```

This copies `scripts/co.9arm.kuro-publish.plist` into `~/Library/LaunchAgents/` and loads it via `launchctl bootstrap`. Idempotent — re-running reloads after edits. Uninstall with `scripts/uninstall-launchd.sh`.

Logs go to `~/Library/Logs/kuro-publish.{out,err}.log`. `launchd` deferred-fires when the Mac wakes, so a sleeping machine at 00:00 Saturday still runs the job on next wake (unlike cron).

## Architecture

Single-composition Remotion project. Flow:

- `src/index.tsx` → `registerRoot(RemotionVideo)`.
- `src/Video.tsx` → declares one `<Composition id="CreditRoll">` at **960×1080, 60fps, 3600 frames (60s)**. Changing video length/size happens here, not in the component.
- `src/CreditRoll.tsx` → the only scene. Two things to know:
  - **Tier system.** Members are grouped by matching the CSV's `Current level` column against Thai regexes in the `tiers` map (`1: /เลี้ยงกาแฟ/`, `2: /เลี้ยงข้าว/`, `3: /ผ่อนบ้าน/`). Tier 4 (`becky_style`) is hardcoded as a single name. Within a tier, members are sorted by `Total time as member (months)` descending.
  - **Per-member overrides.** `customStyles` is a case-sensitive `Record<memberName, React.CSSProperties>` at the top of the file — that's where you add italic/bold/color for a specific handle.
  - **Scroll animation.** `interpolate(frame, [0, durationInFrames], [1080*1.2, -(height+300)])` drives a `translateY` on the members container. `height` is measured after CSV load via `ref.current.scrollHeight` inside an `onLoad` callback; if content grows beyond what fits in 60s the scroll simply clamps at the end.

## Non-obvious gotchas

- `src/Video.tsx` declares `defaultProps: { titleText, titleColor }`, and `.github/workflows/render-video.yml` passes these as `--props`, but **`CreditRoll` does not read them** — the workflow inputs are vestigial. Don't assume changing `titleText` does anything without wiring it up.
- The GitHub Actions workflow uploads `out/video.mp4`, but `npm run build` writes `out/CreditRoll.mp4`. CI artifact upload will fail until one of them is renamed.
- `remotion.config.ts` sets `setOverwriteOutput(true)` — local builds silently clobber `out/CreditRoll.mp4`.
- `tsconfig.json` has `"lib": ["es2015"]` (not `dom`), relying on `@types/web` for DOM types. Don't "fix" this by adding `dom` to `lib` without checking Remotion's expectations. Root tsconfig `exclude`s `scripts/` so its Node-specific config doesn't leak into the Remotion build; `scripts/` is typechecked by its own `scripts/tsconfig.json`.
- `scripts/upload.ts` has two hardcoded constants that get committed: `GDRIVE_FOLDER_ID` (destination Drive folder) and `GOG_ACCOUNT` (gog identity selector). Both are effectively public info (folder ID appears in Drive share links; account email is author contact), so hardcoding is intentional — no env var indirection.
- Formatting uses tabs (see `.prettierrc` and existing files). ESLint extends `@remotion` only.
