#!/bin/sh
set -eu

remote=${1:-origin}
remote_ref=${2:-}
if [ -n "$remote_ref" ]; then
  range=$(printf '%s' "$remote_ref" | sed 's/^[^:]*://')
else
  branch=$(git symbolic-ref --short HEAD 2>/dev/null || printf main)
  if git rev-parse --verify --quiet "${remote}/${branch}" >/dev/null; then
    range="$(git merge-base HEAD "${remote}/${branch}")..HEAD"
  elif git rev-parse --verify --quiet "${remote}/main" >/dev/null; then
    range="$(git merge-base HEAD "${remote}/main")..HEAD"
  else
    range="$(git rev-list --max-parents=0 HEAD | tail -1)..HEAD"
  fi
fi

if command -v gitleaks >/dev/null 2>&1; then
  if [ -n "$range" ]; then
    gitleaks git --redact --verbose "$range"
  else
    gitleaks git --redact --verbose "$range"
  fi
fi
