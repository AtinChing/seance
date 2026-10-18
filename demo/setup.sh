#!/usr/bin/env bash
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEANCE_DIR="$(cd "$DEMO_DIR/.." && pwd)"
TEMPLATE="$DEMO_DIR/payments-template"
REPO="$DEMO_DIR/payments-repo"
SEANCE_BIN="$SEANCE_DIR/cli/bin.js"

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) echo "usage: demo/setup.sh [--force]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -e "$REPO" ]; then
  if [ "$force" -ne 1 ]; then
    echo "$REPO already exists. Re-run with --force to recreate it." >&2
    exit 1
  fi
  rm -rf "$REPO"
fi

git_plain() { env -u CLAUDECODE git "$@"; }

cp -R "$TEMPLATE" "$REPO"
cd "$REPO"
git_plain init -q -b main
npm install --silent --no-audit --no-fund
git_plain add -A
git_plain commit -q -m "payments scaffold"
echo "created $REPO (commit: payments scaffold)"

if [ -f "$SEANCE_BIN" ]; then
  if node "$SEANCE_BIN" init; then
    git_plain add -A
    if git_plain diff --cached --quiet; then
      echo "seance init made no changes to commit"
    else
      git_plain commit -q -m "add seance"
      echo "committed seance init (commit: add seance)"
    fi
  else
    echo "warning: 'seance init' failed; skipped. Run it later inside $REPO." >&2
  fi
else
  echo "note: $SEANCE_BIN not found; skipped seance init." >&2
fi

cat <<NEXT

Next steps:
  cd "$REPO"
  claude -p "\$(cat ../seed-prompt.md)" --permission-mode acceptEdits
  git log -1
  seance ls
See demo/README.md for the full run order.
NEXT
