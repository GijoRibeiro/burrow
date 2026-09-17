#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
go run -buildvcs=false ./packaging/macos/icon/
(cd web && npm ci && npm run build)
go build -buildvcs=false -o bin/cloovies-workspace ./cmd/workspace
stage=$(mktemp -d /tmp/cloovies-app.XXXXXX)
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Cloovies.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources/FontLicenses"
cp web/public/font-licenses/*.txt "$bundle/Contents/Resources/FontLicenses/"
mkdir -p "$bundle/Contents/Resources/ThirdPartyLicenses"
cp web/node_modules/marked/LICENSE "$bundle/Contents/Resources/ThirdPartyLicenses/Marked.txt"
cp web/node_modules/dompurify/LICENSE "$bundle/Contents/Resources/ThirdPartyLicenses/DOMPurify-Apache.txt"
mkdir -p "$bundle/Contents/Resources/Setup"
cp app/setup/install.command "$bundle/Contents/Resources/Setup/"
iconutil -c icns build/macos/icon.iconset -o "$bundle/Contents/Resources/AppIcon.icns"
for architecture in arm64 x86_64; do
  case "$architecture" in arm64) go_arch=arm64 ;; x86_64) go_arch=amd64 ;; esac
  GOOS=darwin GOARCH="$go_arch" go build -buildvcs=false -o "$stage/server-$architecture" ./cmd/workspace
  swiftc app/workspace.swift -o "$stage/app-$architecture" -framework Cocoa -framework WebKit -target "$architecture-apple-macos13.0"
done
lipo -create "$stage/server-arm64" "$stage/server-x86_64" -output "$bundle/Contents/MacOS/cloovies-workspace"
lipo -create "$stage/app-arm64" "$stage/app-x86_64" -output "$bundle/Contents/MacOS/Cloovies"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Cloovies</string>
<key>CFBundleName</key><string>Cloovies</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIdentifier</key><string>com.cloovies.workspace</string>
<key>CFBundleVersion</key><string>12</string>
<key>CFBundleShortVersionString</key><string>0.6.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSDocumentsFolderUsageDescription</key><string>Cloovies opens terminals and Git worktrees in your project folders.</string>
<key>NSLocalNetworkUsageDescription</key><string>Cloovies connects to its local terminal server.</string>
</dict></plist>
PLIST
codesign --force --sign - "$bundle/Contents/MacOS/cloovies-workspace"
codesign --force --sign - "$bundle"
mkdir -p build/macos
ditto "$bundle" build/macos/Cloovies.app
printf 'Built %s/build/macos/Cloovies.app\n' "$PWD"
