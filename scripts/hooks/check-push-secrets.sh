#!/bin/sh
set -eu

remote=${1:-origin}
remote_ref=${2:-}
if [ -n "$remote_ref" ]; then
  range=$(printf '%s' "$remote_ref" | sed 's/^[^:]*://')
else
  branch=$(git symbolic-ref --short HEAD 2>/dev/null || printf main)
  range="$(git merge-base HEAD "${remote}/${branch}")..HEAD"
fi

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --redact --verbose "$range"
fi
