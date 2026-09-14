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
release_zip="$PWD/build/release/Cloovies-mac-universal.zip"
/usr/bin/ditto -c -k --norsrc --keepParent "$stage/Cloovies.app" build/release/Cloovies-mac-universal.zip
# Include setup instructions beside the app in the archive.
(cd "$stage" && /usr/bin/zip -q "$release_zip" READ-ME-FIRST.md)
shasum -a 256 build/release/Cloovies-mac-universal.zip > build/release/Cloovies-mac-universal.zip.sha256
printf 'Share build/release/Cloovies-mac-universal.zip\n'
