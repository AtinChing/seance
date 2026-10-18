#!/usr/bin/env bash
# Opener, part 1: "In the good old days, you ran git blame and asked Sarah."
# Prints the blame for src/retry.ts:1 in a repo where a person wrote it, then opens the chat UI on the Sarah DM.
# usage: demo/good-old-days.sh [--no-pause] [--no-open]
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/good-old-days/lib.sh"
parse_common_args "$@"

REPO="${SEANCE_GOOD_OLD_DAYS_REPO:-$HOME/seance-demo/good-old-days}"
"$DEMO_DIR/good-old-days/make-repo.sh" >/dev/null
cd "$REPO"

show_cmd "git blame -L 1,1 src/retry.ts"
git blame --date=short -L 1,1 src/retry.ts | fmt_blame

sha="$(git blame --porcelain -L 1,1 src/retry.ts | head -1 | cut -d' ' -f1)"
printf '\n  %s↳%s %s%s%s  %s·%s  %s  %s·%s  %s"%s"%s\n' \
  "$C_DIM" "$C_RESET" \
  "$C_BOLD$C_YELLOW" "$(git log -1 --format='%an <%ae>' "$sha")" "$C_RESET" \
  "$C_DIM" "$C_RESET" "$(git log -1 --date=format:'%b %-d, %Y' --format='%ad' "$sha")" \
  "$C_DIM" "$C_RESET" "$C_DIM" "$(git log -1 --format='%s' "$sha")" "$C_RESET"
printf '  %sA person wrote it. So you ask her.%s\n' "$C_DIM" "$C_RESET"

beat "enter: ask Sarah"
open_chat "sarah"
