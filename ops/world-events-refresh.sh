#!/usr/bin/env bash
#
# Refresh the world-events catalogue on the VPS and propose it as a pull
# request. This is the fallback for when GitHub-hosted scheduled workflows are
# not permitted to open pull requests; it is otherwise the same job the
# .github/workflows/world-events-refresh.yml runs.
#
# What it does, in order:
#   1. fetch the base branch into a dedicated refresh branch;
#   2. harvest + rank the catalogue (Wikipedia/Wikidata, offline-safe);
#   3. run the full test suite — a degraded catalogue is never pushed;
#   4. commit only the four data artifacts and push the branch;
#   5. open a pull request. It NEVER commits to main: the machine proposes, a
#      human reviews the coverage report and authorises.
#
# Setup:
#   Create a fine-grained GitHub token scoped to vitruvyan/terraveler with
#   "Contents: Read and write" and "Pull requests: Read and write". Store it in
#   a root-only env file, e.g. ~/.terraveler-world-events.env:
#
#       TERRAVELER_GITHUB_TOKEN=github_pat_...
#
#   Then, in crontab (monthly, 04:17 on the 1st):
#
#       17 4 1 * * . $HOME/.terraveler-world-events.env && \
#         $HOME/terraveler/ops/world-events-refresh.sh >> $HOME/world-events-refresh.log 2>&1
#
# Environment overrides:
#   TERRAVELER_REPO_DIR   checkout to operate on        (default ~/terraveler)
#   TERRAVELER_REPO_SLUG  owner/name on GitHub          (default vitruvyan/terraveler)
#   TERRAVELER_BASE       base branch                   (default main)
#   TERRAVELER_BRANCH     refresh branch                (default chore/world-events-refresh)

set -euo pipefail

REPO_DIR="${TERRAVELER_REPO_DIR:-$HOME/terraveler}"
REPO_SLUG="${TERRAVELER_REPO_SLUG:-vitruvyan/terraveler}"
BASE="${TERRAVELER_BASE:-main}"
BRANCH="${TERRAVELER_BRANCH:-chore/world-events-refresh}"
TOKEN="${TERRAVELER_GITHUB_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "TERRAVELER_GITHUB_TOKEN is not set — see the header of this script." >&2
  exit 1
fi

cd "$REPO_DIR"

# Never run on top of someone's uncommitted work.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is dirty; refusing to refresh." >&2
  exit 1
fi

echo "==> fetching origin/$BASE"
git fetch origin "$BASE"
git checkout -B "$BRANCH" "origin/$BASE"

echo "==> harvesting and ranking the catalogue"
npm ci --no-audit --no-fund
python3 scripts/build_world_events.py
npx tsx scripts/build_world_event_projection.ts

echo "==> verifying"
npm test

git add \
  data/historical-events.json \
  data/world-events-voyages.json \
  data/world_events.json \
  data/world-events-coverage.json

if git diff --cached --quiet; then
  echo "No catalogue changes this month."
  exit 0
fi

git config user.name "Terraveler VPS"
git config user.email "desk@terraveler.com"
git commit -m "chore(world-events): refresh the contextual catalogue"

echo "==> pushing $BRANCH"
# Credential helper rather than a token in the URL, so it never appears in the
# remote's stored config or in `ps` for other users on the box.
git push --force-with-lease \
  -c credential.helper= \
  -c credential.helper='!f() { echo username=x-access-token; echo "password=$TERRAVELER_GITHUB_TOKEN"; }; f' \
  "https://github.com/${REPO_SLUG}.git" "HEAD:refs/heads/${BRANCH}"

COMPARE_URL="https://github.com/${REPO_SLUG}/compare/${BASE}...${BRANCH}?expand=1"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh pr create --repo "$REPO_SLUG" --base "$BASE" --head "$BRANCH" \
    --title "chore(world-events): catalogue refresh" \
    --body "Automated refresh of the contextual world-events catalogue.

- data/historical-events.json — normalised shared catalogue
- data/world-events-voyages.json — per-voyage scoring inputs
- data/world_events.json — client projection
- data/world-events-coverage.json — coverage report

Review the coverage report (especially uncovered) before merging." \
    || echo "PR may already exist. Compare: $COMPARE_URL"
else
  echo "Open a pull request: $COMPARE_URL"
fi
