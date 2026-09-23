#!/usr/bin/env bash
# Mirror a release's installer assets from the PRIVATE source repo to the PUBLIC
# downloads repo. Release assets on a private repo are NOT publicly downloadable,
# so the site serves them from the public mirror instead. Run locally with an
# authenticated `gh` (the same account that owns both repos).
#
#   bash scripts/mirror-to-dist.sh [TAG]
#
# TAG defaults to the latest release of the source repo. Safe to re-run; uploads
# clobber. Only installer artifacts are copied — never source.
set -euo pipefail

SRC="explorearafat/sylor"
DST="explorearafat/sylor-dist"
ASSETS=("Myto-Setup.exe" "myto.apk")

TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(gh release view --repo "$SRC" --json tagName -q .tagName)"
fi

echo "Mirroring $SRC@$TAG -> $DST"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

found=()
for a in "${ASSETS[@]}"; do
  if gh release download "$TAG" --repo "$SRC" --pattern "$a" --dir "$workdir" 2>/dev/null; then
    found+=("$workdir/$a")
    echo "  + pulled $a"
  else
    echo "  - $a not on this release (skipping)"
  fi
done

if [ ${#found[@]} -eq 0 ]; then
  echo "No installer assets found on $SRC@$TAG; nothing to mirror." >&2
  exit 1
fi

if ! gh release view "$TAG" --repo "$DST" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$DST" --title "Myto $TAG" \
    --notes "Public installers for Myto $TAG. The app is closed-source; only the built .exe / .apk live here."
fi
gh release upload "$TAG" --repo "$DST" --clobber "${found[@]}"

echo "Done. Public downloads:"
echo "  https://github.com/$DST/releases/latest/download/Myto-Setup.exe"
echo "  https://github.com/$DST/releases/latest/download/myto.apk"
