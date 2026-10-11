#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" != "--no-build" ]; then ./scripts/build-workspace-app.sh; fi
stage=$(mktemp -d /tmp/cloovies-share.XXXXXX)
trap 'rm -rf "$stage"' EXIT
ditto build/macos/Cloovies.app "$stage/Cloovies.app"
cp docs/INSTALL.md "$stage/READ-ME-FIRST.md"
xattr -cr "$stage/Cloovies.app"
codesign --force --sign "${CLOOVIES_SIGN_IDENTITY:--}" "$stage/Cloovies.app/Contents/MacOS/cloovies-workspace"
codesign --force --sign "${CLOOVIES_SIGN_IDENTITY:--}" "$stage/Cloovies.app"
codesign --verify --deep --strict "$stage/Cloovies.app"
mkdir -p build/release
version=$(tr -d '[:space:]' < VERSION)
versioned="Cloovies-$version-mac-universal.zip"
release_zip="$PWD/build/release/$versioned"
rm -f "$release_zip" "$release_zip.sha256"
/usr/bin/ditto -c -k --norsrc --keepParent "$stage/Cloovies.app" "$release_zip"
# Include setup instructions beside the app in the archive.
(cd "$stage" && /usr/bin/zip -q "$release_zip" READ-ME-FIRST.md)
# The unversioned name stays valid for docs and existing links.
(cd build/release && rm -f Cloovies-mac-universal.zip Cloovies-mac-universal.zip.sha256 \
  && cp "$versioned" Cloovies-mac-universal.zip \
  && shasum -a 256 "$versioned" Cloovies-mac-universal.zip > "$versioned.sha256" \
  && cp "$versioned.sha256" Cloovies-mac-universal.zip.sha256)
printf 'Share build/release/%s (also copied to build/release/Cloovies-mac-universal.zip)\n' "$versioned"
