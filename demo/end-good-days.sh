#!/usr/bin/env bash
# Opener, part 2: "Now agents write the code, and that session's gone."
# Same blame in the real demo repo: the line's author is a Claude Code session, named by its Agent-Session trailer.
# Then opens the chat UI on a DM with that session (it's gone), followed by the Séance reveal.
# usage: demo/end-good-days.sh [--no-pause] [--no-open]
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/good-old-days/lib.sh"
parse_common_args "$@"

REPO="${SEANCE_DEMO_REPO:-$HOME/seance-demo/payments-repo}"
FILE="src/retry.ts"
if [ ! -d "$REPO/.git" ]; then
  echo "$REPO is not a git repo yet. Run demo/setup.sh and the seed session first (demo/README.md)." >&2
  exit 1
fi
cd "$REPO"

show_cmd "git blame -L 1,1 $FILE"
git blame --date=short -L 1,1 "$FILE" | fmt_blame

sha="$(git blame --porcelain -L 1,1 "$FILE" | head -1 | cut -d' ' -f1)"
short="$(git rev-parse --short "$sha")"
address="$(git log -1 --format='%(trailers:key=Agent-Session,valueonly)' "$sha" | head -1 | tr -d '[:space:]')"

beat "enter: who is that, really?"
show_cmd "git log -1 --format=%B $short"
git log -1 --format='%B' "$sha" | awk 'NF{for(;b>0;b--)print "";print;next}{b++}' | while IFS= read -r line; do
  case "$line" in
    Agent-Session:*) printf '    %s%s%s\n' "$C_BOLD$C_MAGENTA" "$line" "$C_RESET" ;;
    *) printf '    %s\n' "$line" ;;
  esac
done

if [ -z "$address" ]; then
  echo "  (no Agent-Session trailer on $short; was the seed session run with Séance installed?)" >&2
  address="s-055fcb2d@safe-maple.primitive.email"
fi
printf '\n  %s↳%s not a person. A Claude Code session: %s%s%s\n' "$C_DIM" "$C_RESET" "$C_BOLD$C_MAGENTA" "$address" "$C_RESET"

beat "enter: seance whois"
show_cmd "seance whois $FILE:1"
if command -v seance >/dev/null 2>&1; then
  seance whois "$FILE:1" || echo "  (seance whois failed; carrying on)" >&2
elif [ -f "$SEANCE_DIR/cli/bin.js" ]; then
  node "$SEANCE_DIR/cli/bin.js" whois "$FILE:1" || echo "  (seance whois failed; carrying on)" >&2
else
  echo "  (seance CLI not found; carrying on)" >&2
fi

ended="$(git log -1 --date=format:'%b %-d' --format='%cd' "$sha")"
printf '\n  %sThat session is over. Ask it anyway?%s\n' "$C_DIM" "$C_RESET"
beat "enter: message the session"
open_chat "session?address=${address}&ended=${ended// /%20}"
