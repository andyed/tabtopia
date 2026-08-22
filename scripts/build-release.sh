#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

version=$(node -p 'require("./manifest.json").version')
package_version=$(node -p 'require("./package.json").version')

if [ "$version" != "$package_version" ]; then
  echo "manifest.json ($version) and package.json ($package_version) disagree" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "tracked changes are present; commit the release candidate before packaging" >&2
  exit 1
fi

release_dir="tabtopia-v$version"
archive="dist/$release_dir.zip"
mkdir -p dist

git archive \
  --format=zip \
  --prefix="$release_dir/" \
  --output="$archive" \
  HEAD -- \
  .agents/skills/browser-now \
  .claude/skills/browser-now \
  CHANGELOG.md \
  LICENSE \
  PRIVACY.md \
  assets \
  icons \
  manifest.json \
  mcp \
  readme.md \
  src

entries=$(unzip -Z1 "$archive")

for required in \
  "$release_dir/manifest.json" \
  "$release_dir/src/background.js" \
  "$release_dir/mcp/server.js" \
  "$release_dir/.agents/skills/browser-now/SKILL.md" \
  "$release_dir/.claude/skills/browser-now/SKILL.md"
do
  if ! printf '%s\n' "$entries" | grep -Fxq "$required"; then
    echo "release archive is missing $required" >&2
    exit 1
  fi
done

if printf '%s\n' "$entries" | grep -Eq '(^|/)(node_modules|tests|docs|references|data|\.codex|TODO\.md|\.DS_Store)(/|$)|\.(bak|orig|rej)$'; then
  echo "release archive contains a forbidden development or private path" >&2
  exit 1
fi

archive_version=$(unzip -p "$archive" "$release_dir/manifest.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
if [ "$archive_version" != "$version" ]; then
  echo "archive manifest version $archive_version does not match $version" >&2
  exit 1
fi

shasum -a 256 "$archive"
echo "Built $archive from $(git rev-parse HEAD)"
