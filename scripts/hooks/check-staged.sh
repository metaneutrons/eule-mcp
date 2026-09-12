#!/bin/sh
set -eu

branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)
if [ "$branch" = "main" ]; then
  echo "Direct commits to main are not permitted; use a pull request." >&2
  exit 1
fi

bad=$(git diff --cached --name-only | awk '/(^|\/)(node_modules|\.pnpm|dist|build|target|coverage|\.env($|\.)|.*\.db$|.*\.pem$|.*\.key$)/ {print}')
if [ -n "$bad" ]; then
  echo "Staged generated, local-state, or credential files:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi

while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ "$(git diff --cached --diff-filter=D --name-only -- "$file")" = "$file" ] && continue
  size=$(git cat-file -s ":$file")
  if [ "$size" -gt 5242880 ]; then
    echo "Staged file exceeds 5 MiB: $file" >&2
    exit 1
  fi
done <<EOF
$(git diff --cached --name-only)
EOF
