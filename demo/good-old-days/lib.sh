# Shared helpers for demo/good-old-days.sh and demo/end-good-days.sh. Source, don't run.

GOD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$GOD_LIB_DIR/.." && pwd)"
SEANCE_DIR="$(cd "$DEMO_DIR/.." && pwd)"
CHAT_INDEX="$DEMO_DIR/chat/index.html"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_YELLOW=$'\033[33m'; C_MAGENTA=$'\033[35m'; C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_YELLOW=""; C_MAGENTA=""; C_CYAN=""; C_GREEN=""
fi

PAUSE=1
[ -n "${SEANCE_DEMO_NO_PAUSE:-}" ] && PAUSE=0
OPEN_CHAT=1

parse_common_args() {
  for arg in "$@"; do
    case "$arg" in
      --no-pause) PAUSE=0 ;;
      --no-open) OPEN_CHAT=0 ;;
      -h|--help) echo "usage: $(basename "$0") [--no-pause] [--no-open]"; exit 0 ;;
      *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
  done
  # Only wait for Enter when a person is at the keyboard.
  if [ ! -t 0 ] || [ ! -t 1 ]; then PAUSE=0; fi
}

# Wait for Enter so the presenter can talk over each step.
beat() {
  [ "$PAUSE" -eq 1 ] || return 0
  printf '%s' "${C_DIM}  ${1:-press enter}  ⏎${C_RESET}"
  read -r _ || true
  printf '\033[1A\033[2K'
}

show_cmd() { printf '\n%s$%s %s%s%s\n' "$C_GREEN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }

# Colors one `git blame --date=short` line: hash dim, author highlighted, code plain.
fmt_blame() {
  local line hash rest author date num code re
  re='^(\^?[0-9a-f]+) \((.*) ([0-9]{4}-[0-9]{2}-[0-9]{2}) +([0-9]+)\) (.*)$'
  while IFS= read -r line; do
    if [[ "$line" =~ $re ]]; then
      hash="${BASH_REMATCH[1]}"; author="${BASH_REMATCH[2]}"; date="${BASH_REMATCH[3]}"
      num="${BASH_REMATCH[4]}"; code="${BASH_REMATCH[5]}"
      author="${author%"${author##*[! ]}"}"
      printf '%s%s%s (%s%s%s %s%s%s %s) %s\n' \
        "$C_DIM" "$hash" "$C_RESET" "$C_BOLD$C_YELLOW" "$author" "$C_RESET" "$C_DIM" "$date" "$C_RESET" "$num" "$code"
    else
      printf '%s\n' "$line"
    fi
  done
}

# Opens demo/chat/index.html at a route (e.g. "sarah", "session?address=..").
# `open` on macOS can drop the #fragment of a file:// URL, so we open a tiny launcher page
# that redirects to the real URL with its fragment intact.
open_chat() {
  local route="$1" target launcher
  target="file://${CHAT_INDEX// /%20}#${route}"
  printf '\n%schat:%s %s\n' "$C_DIM" "$C_RESET" "$target"
  [ "$OPEN_CHAT" -eq 1 ] || return 0
  launcher="${TMPDIR:-/tmp}"
  launcher="${launcher%/}/seance-chat-${route%%\?*}.html"
  cat > "$launcher" <<HTML
<!doctype html><meta charset="utf-8"><title>acme-payments</title>
<meta http-equiv="refresh" content="0; url=$target">
<script>location.replace($(printf '%s' "$target" | sed 's/["\\]/\\&/g; s/.*/"&"/'));</script>
HTML
  if command -v open >/dev/null 2>&1; then
    open "$launcher"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$launcher" >/dev/null 2>&1 &
  else
    echo "open this in a browser: $target"
  fi
}
