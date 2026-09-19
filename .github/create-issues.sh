#!/usr/bin/env bash
# Create this repository's Wave Program issues, one stage at a time.
#
#   ./.github/create-issues.sh 1              create every stage-1 issue
#   ./.github/create-issues.sh 2 --dry-run    show what stage 2 would create
#
# Requires: gh (authenticated, `gh auth status`) and jq.
# Labels are created if they do not already exist.
set -euo pipefail

STAGE="${1:-}"
DRY_RUN="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HERE/wave-issues.json"

if [[ ! "$STAGE" =~ ^[123]$ ]]; then
  echo "usage: $(basename "$0") <stage 1|2|3> [--dry-run]" >&2
  exit 64
fi
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 69; }
[[ -f "$DATA" ]] || { echo "error: $DATA not found" >&2; exit 66; }

# gh is only needed for a real run — --dry-run works with jq alone.
if [[ "$DRY_RUN" != "--dry-run" ]]; then
  command -v gh >/dev/null || { echo "error: gh is required (or pass --dry-run)" >&2; exit 69; }
  gh auth status >/dev/null 2>&1 || { echo "error: run 'gh auth login' first" >&2; exit 77; }
fi

COUNT=$(jq --argjson s "$STAGE" '[.issues[] | select(.stage == $s)] | length' "$DATA")
echo "Stage $STAGE: $COUNT issue(s)"
[[ "$COUNT" -eq 0 ]] && exit 0

# Make sure every label exists, otherwise gh issue create fails on the first one.
if [[ "$DRY_RUN" != "--dry-run" ]]; then
  jq -r --argjson s "$STAGE" '[.issues[] | select(.stage == $s) | .labels[]] | unique[]' "$DATA" \
  | while read -r label; do
      gh label create "$label" --force >/dev/null 2>&1 || true
    done
fi

jq -c --argjson s "$STAGE" '.issues[] | select(.stage == $s)' "$DATA" | while read -r row; do
  title=$(jq -r '.title' <<<"$row")
  body=$(jq -r '.body'  <<<"$row")
  labels=$(jq -r '.labels | join(",")' <<<"$row")

  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo
    echo "── would create ────────────────────────────────────────────"
    echo "title:  $title"
    echo "labels: $labels"
    echo "body:   $(head -c 160 <<<"$body")..."
    continue
  fi

  url=$(gh issue create --title "$title" --body "$body" --label "$labels")
  echo "  created: $url"
done

echo "Done."
