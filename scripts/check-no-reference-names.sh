#!/usr/bin/env bash
# The reference engine is referred to as "the reference engine" and by nothing
# else. Its product name and its Java package namespace must not appear
# anywhere in this repository -- code, config, docs, CSS, test fixtures or
# commit messages.
#
# This is a hard rule with no exceptions, so it is a build step rather than a
# habit. See CLAUDE.md.
#
# The white-label brands go with it. The reference shipped four enterprise
# brands and two broker skins; garuda is one product with one brand, so those
# names have no reason to appear either -- and a stray one is how a build
# matrix grows back.
set -euo pipefail

cd "$(dirname "$0")/.."

FORBIDDEN='jktvs|com\.sdoosa|shareindia|5paisa|pragya'

files=$(git ls-files \
    | grep -Ev '^frontend/(node_modules|dist)/' \
    | grep -Fxv 'docs/JAVA_FEATURE_INVENTORY.md' \
    | grep -Fxv 'scripts/check-no-reference-names.sh')

if hits=$(printf '%s\n' "$files" | xargs -r grep -EinI "$FORBIDDEN" 2>/dev/null); then
    echo "the reference engine's name must not appear in this repository:" >&2
    echo "$hits" >&2
    exit 1
fi

echo "no reference-engine names in $(printf '%s\n' "$files" | wc -l) tracked files"
