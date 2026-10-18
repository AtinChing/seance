#!/usr/bin/env bash
# Generates the "good old days" repo: same retry.ts, but line 1 was written by a person (Sarah Chen).
# Source lives here without a nested .git; the git repo is built under ~/seance-demo/good-old-days.
# Commits run with CLAUDECODE unset and hooks disabled, so Séance never stamps them.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${SEANCE_GOOD_OLD_DAYS_REPO:-$HOME/seance-demo/good-old-days}"

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) echo "usage: demo/good-old-days/make-repo.sh [--force]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -d "$REPO/.git" ] && [ "$force" -ne 1 ]; then
  exit 0
fi
rm -rf "$REPO"
mkdir -p "$REPO/src"

g() {
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT git -C "$REPO" \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"
}

commit_as() { # name email date message
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_AUTHOR_DATE="$3" \
  GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" GIT_COMMITTER_DATE="$3" \
    g commit -q --no-verify -m "$4"
}

g init -q -b main

# 1. Marcus scaffolds the service with a first-guess delay.
cp "$SRC_DIR/README.md" "$REPO/README.md"
sed 's/^export const RETRY_BASE_DELAY = 0\.37;/export const RETRY_BASE_DELAY = 0.25;/' \
  "$SRC_DIR/src/retry.ts" > "$REPO/src/retry.ts"
g add -A
commit_as "Marcus Lee" "marcus@example.com" "2019-02-26T11:08:00-0800" "payments scaffold"

# 2. Sarah changes line 1 after the double-charge incident. The commit message doesn't say why.
cp "$SRC_DIR/src/retry.ts" "$REPO/src/retry.ts"
g add -A
commit_as "Sarah Chen" "sarah@example.com" "2019-03-14T16:42:00-0700" "tune retry backoff"

echo "created $REPO"
