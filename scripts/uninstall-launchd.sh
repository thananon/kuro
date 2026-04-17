#!/bin/bash
# Remove the co.9arm.kuro-publish LaunchAgent.

set -euo pipefail

DST_DIR="$HOME/Library/LaunchAgents"
DST_PLIST="$DST_DIR/co.9arm.kuro-publish.plist"
LABEL="co.9arm.kuro-publish"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
	echo "unloading $LABEL..."
	launchctl bootout "gui/$(id -u)" "$DST_PLIST" || true
fi

if [ -f "$DST_PLIST" ]; then
	rm -f "$DST_PLIST"
	echo "removed $DST_PLIST"
else
	echo "nothing installed at $DST_PLIST"
fi
