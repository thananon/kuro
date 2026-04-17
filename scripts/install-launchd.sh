#!/bin/bash
# Install (or reinstall) the co.9arm.kuro-publish LaunchAgent so
# `npm run publish` fires every Saturday at 00:00 local time.
#
# Idempotent: safe to re-run after editing the plist.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC_PLIST="$SCRIPT_DIR/co.9arm.kuro-publish.plist"
DST_DIR="$HOME/Library/LaunchAgents"
DST_PLIST="$DST_DIR/co.9arm.kuro-publish.plist"
LABEL="co.9arm.kuro-publish"

mkdir -p "$DST_DIR"
mkdir -p "$HOME/Library/Logs"

# If already loaded, unload first so the new plist takes effect.
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
	echo "unloading existing $LABEL..."
	launchctl bootout "gui/$(id -u)" "$DST_PLIST" || true
fi

cp "$SRC_PLIST" "$DST_PLIST"
chmod 644 "$DST_PLIST"

echo "loading $LABEL..."
launchctl bootstrap "gui/$(id -u)" "$DST_PLIST"

launchctl print "gui/$(id -u)/$LABEL" | grep -E '^\s*(state|path|program)' || true

echo
echo "installed. next fire: Saturday 00:00 local."
echo "logs: ~/Library/Logs/kuro-publish.{out,err}.log"
echo "uninstall: scripts/uninstall-launchd.sh"
