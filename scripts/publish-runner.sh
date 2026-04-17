#!/bin/zsh -l
# Invoked by the co.9arm.kuro-publish LaunchAgent on its schedule.
#
# -l makes zsh a login shell so /etc/zprofile, ~/.zprofile, and ~/.zshrc
# are sourced — that's what brings Homebrew, node, npm, tsx, and gog onto
# PATH when launchd runs us from its minimal environment.
#
# Belt-and-suspenders PATH prepend in case the user's profile drops it.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO_DIR="/Users/tpatinya/kuro"
cd "$REPO_DIR"

printf '\n===== %s =====\n' "$(date -Iseconds)"
exec npm run publish
