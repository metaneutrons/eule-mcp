#!/bin/sh
set -eu

msg_file=${1:?commit message path required}
body=$(sed -e '/^#/d' -e '/^diff --git /,$d' "$msg_file")
subject=$(printf '%s\n' "$body" | sed -e '/^[[:space:]]*$/d' -e 1q)

case "$subject" in
  "Merge "*|"Revert \""*|"fixup!"*|"squash!"*|"amend!"*) exit 0 ;;
esac

if ! printf '%s' "$subject" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: .+'; then
  echo "Commit rejected: use a Conventional Commit subject." >&2
  exit 1
fi
if [ "${#subject}" -gt 100 ]; then
  echo "Commit rejected: subject exceeds 100 characters." >&2
  exit 1
fi
if printf '%s\n' "$body" | grep -Eiq 'co-authored-by:.*(claude|anthropic|noreply@anthropic\.com)|generated with .*claude code|🤖 generated with'; then
  echo "Commit rejected: AI attribution trailers are not permitted." >&2
  exit 1
fi
