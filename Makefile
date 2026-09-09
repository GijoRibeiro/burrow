.PHONY: dev daemon tui web build build-daemon build-tui build-web build-bitwise build-app app rebuild test clean check-deps install icon package release sparkle sparkle-keys sparkle-pubkey signing-identity appcast

# Embed the repo root into binaries that host the rebuild handler, so
# `make rebuild` from inside the app knows where its own source lives —
# regardless of which machine built it or where the repo was cloned.
REPO_ROOT  := $(abspath $(CURDIR))
REPO_LDFLAG := -X github.com/gijo/cloovies/internal/server.buildRepoPath=$(REPO_ROOT)

# Release version, injected into the binary + Info.plist so the auto-updater
# has a real version to compare against. Derived from `make release VERSION=vX`
# (leading `v` stripped). Empty for plain dev builds → the daemon reports the
# 0.0.0-dev sentinel and never offers an update to itself.
VERSION_NUM    := $(patsubst v%,%,$(VERSION))
VERSION_LDFLAG := $(if $(VERSION_NUM),-X github.com/gijo/cloovies/internal/server.buildVersion=$(VERSION_NUM),)

# Git description of the source the binary was built from — e.g. "v0.4.1-3-gc5455de"
# (3 commits past v0.4.1) or with a "-dirty" suffix when the tree has uncommitted
# changes; a bare short hash if no tag is reachable. ALWAYS injected so a plain
# dev build (no VERSION) can still report WHICH commit it is in the diagnostics
# panel instead of a useless "0.0.0-dev". Purely informational: release builds
# show VERSION and ignore this, and the auto-updater's dev detection still keys
# off buildVersion being empty — so no-nag behaviour is unchanged. See
# server.displayVersion / currentVersion.
GIT_DESCRIBE   = $(shell git describe --tags --always --dirty 2>/dev/null)
GIT_LDFLAG     = $(if $(GIT_DESCRIBE),-X github.com/gijo/cloovies/internal/server.buildGitDescribe=$(GIT_DESCRIBE),)
LDFLAGS        = $(REPO_LDFLAG) $(VERSION_LDFLAG) $(GIT_LDFLAG)

# Minimum macOS the shipped app supports. swiftc with no explicit target
# defaults the Mach-O minos to the BUILD machine's OS version, so a build on
# macOS 26 silently demanded macOS 26 from users ("you must update your OS").
# Pin a real floor so older Macs (Ventura+) can run it. Sparkle 2.9.2 and the
# Cocoa/WebKit APIs we use all support 13.0.
MACOS_TARGET := 13.0

# Sparkle (auto-updater). Cached under third_party/ (gitignored) and fetched
# on demand — no binary committed to the repo. NOT named vendor/, which Go
# reserves for module vendoring. Pinned for reproducibility.
SPARKLE_VER := 2.9.2
SPARKLE_DIR := third_party/sparkle
SPARKLE_FRAMEWORK := $(SPARKLE_DIR)/Sparkle.framework

# Public distribution repo. The source repo (origin) is private, and GitHub
# release assets on a private repo 404 for unauthenticated clients — Sparkle
# fetches the appcast + zip with no auth, so they must live in a PUBLIC repo.
# Releases (zip + signed appcast.xml) are published here; SUFeedURL in
# packaging/macos/Info.plist points at this repo's latest release. The source
# stays private. See RELEASING.md.
RELEASE_REPO := GijoRibeiro/bitwise-releases

# Paths
MACOS_BUILD_DIR := build/macos
APP_BUNDLE      := $(MACOS_BUILD_DIR)/bitwise.app
APP_CONTENTS    := $(APP_BUNDLE)/Contents
APP_MACOS       := $(APP_CONTENTS)/MacOS
APP_RESOURCES   := $(APP_CONTENTS)/Resources
ICONSET_DIR     := $(MACOS_BUILD_DIR)/icon.iconset
RELEASE_DIR     := build/release
RELEASE_ZIP     := $(RELEASE_DIR)/bitwise-macos.zip

# Signing staging area OUTSIDE the iCloud-synced repo. macOS's iCloud file
# provider daemon aggressively adds com.apple.FinderInfo and similar xattrs
# to .app bundles inside ~/Documents faster than we can clear them, which
# causes `codesign` to fail with "resource fork, Finder information, or
# similar detritus not allowed". We assemble + sign in /tmp (which iCloud
# doesn't watch) and then ditto the signed bundle back into build/macos/
# so `make app` can still launch it in place. The release zip is created
# from the clean /tmp copy.
SIGN_DIR     := /tmp/cloovies-build
SIGN_APP     := $(SIGN_DIR)/bitwise.app
SIGN_CONT    := $(SIGN_APP)/Contents
SIGN_MACOS   := $(SIGN_CONT)/MacOS
SIGN_RES     := $(SIGN_CONT)/Resources

# Code-signing identity. macOS TCC (privacy) remembers a granted permission
# — Documents folder, Full Disk Access — keyed to the signed code's "designated
# requirement". Ad-hoc signing (`--sign -`) has NO stable identity: every build
# gets a fresh cdhash, so each release looks like a brand-new program and macOS
# re-prompts for (and won't persist) Documents access — which the bundled daemon
# trips every scan tick when an agent's repo lives under ~/Documents. A stable
# self-signed cert gives a constant designated requirement, so a one-time Allow
# sticks across all future updates. Created once via `make signing-identity`.
# No Apple Developer account / notarization needed (Gatekeeper behaviour is
# unchanged from ad-hoc: right-click → Open on first launch). Falls back to
# ad-hoc on machines without the cert so the build still works there.
SIGN_IDENTITY := bitwise-selfsigned
SIGN_ID = $(shell security find-certificate -c "$(SIGN_IDENTITY)" >/dev/null 2>&1 && echo "$(SIGN_IDENTITY)" || echo -)

# Run the TUI client (connects to daemon)
tui:
	go run ./cmd/cloovies/

# Run both daemon and TUI
dev:
	@echo "Terminal 1:  make daemon"
	@echo "Terminal 2:  make tui"

# Run the daemon
daemon:
	go run ./cmd/clooviesd/ --port 3333 --sprites web/assets/sprites

# Run the web dev server (proxies /ws to daemon)
web:
	cd web && npx vite

# Dependency check
check-deps:
	@command -v go >/dev/null 2>&1 || { echo "Error: go is not installed"; exit 1; }
	@command -v node >/dev/null 2>&1 || { echo "Error: node is not installed"; exit 1; }

# Default build is the new terminal workspace.
# Legacy packages remain available through build-app and build-bitwise.
build: workspace-app

build-daemon:
	go build -ldflags "$(REPO_LDFLAG)" -o bin/clooviesd ./cmd/clooviesd/

build-tui:
	go build -o bin/cloovies ./cmd/cloovies/

build-web:
	cd web && npm install && npx vite build

build-bitwise: build-web
	go build -ldflags "$(LDFLAGS)" -o bin/bitwise ./cmd/bitwise/

# Assemble + sign bitwise.app in /tmp (see SIGN_DIR comment at top of Makefile
# for why), then ditto the signed bundle into build/macos/ so `make app` can
# launch it in place. The result is a fully self-contained .app — no external
# dev tools required at runtime.
#
# Ad-hoc codesign (sign identity "-") doesn't cost anything and doesn't require
# an Apple Developer account — it just changes the first-run warning to the
# softer "cannot be verified" dialog, which has a right-click → Open escape
# hatch for end users. For proper notarization we'd need a paid Developer ID.
# Fetch + extract Sparkle into vendor/ (gitignored) if not already present.
# Idempotent: skips the download once the framework is on disk.
sparkle:
	@if [ ! -d "$(SPARKLE_FRAMEWORK)" ]; then \
	  echo "→ fetching Sparkle $(SPARKLE_VER)…"; \
	  mkdir -p $(SPARKLE_DIR); \
	  curl -sSL "https://github.com/sparkle-project/Sparkle/releases/download/$(SPARKLE_VER)/Sparkle-$(SPARKLE_VER).tar.xz" -o /tmp/sparkle-$(SPARKLE_VER).tar.xz; \
	  tar -xf /tmp/sparkle-$(SPARKLE_VER).tar.xz -C $(SPARKLE_DIR); \
	  echo "  → $(SPARKLE_FRAMEWORK)"; \
	fi

build-app: build-bitwise icon sparkle
	@rm -rf $(SIGN_APP)
	@mkdir -p $(SIGN_MACOS) $(SIGN_RES) $(SIGN_CONT)/Frameworks
	cp packaging/macos/Info.plist $(SIGN_CONT)/Info.plist
	@# Stamp the real release version into the bundle so the updater can
	@# compare. No-op for dev builds (VERSION unset) — they keep the
	@# plist's placeholder.
	$(if $(VERSION_NUM),/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $(VERSION_NUM)" -c "Set :CFBundleVersion $(VERSION_NUM)" $(SIGN_CONT)/Info.plist,@true)
	cp bin/bitwise $(SIGN_MACOS)/bitwise-daemon
	@# Embed Sparkle.framework so the in-app updater can link against it at
	@# runtime (rpath points at ../Frameworks below).
	/usr/bin/ditto $(SPARKLE_FRAMEWORK) $(SIGN_CONT)/Frameworks/Sparkle.framework
	swiftc app/main.swift -o $(SIGN_MACOS)/bitwise \
	  -target arm64-apple-macos$(MACOS_TARGET) \
	  -framework Cocoa -framework WebKit \
	  -F $(abspath $(SPARKLE_DIR)) -framework Sparkle \
	  -Xlinker -rpath -Xlinker @executable_path/../Frameworks
	iconutil -c icns $(ICONSET_DIR) -o $(SIGN_RES)/AppIcon.icns
	xattr -cr $(SIGN_APP)
	@echo "Signing with identity: $(SIGN_ID)  (\"-\" = ad-hoc fallback; run 'make signing-identity' for stable TCC grants)"
	@# Sign inside-out with the STABLE identity ($(SIGN_ID)) and FIXED bundle
	@# identifiers so macOS TCC remembers granted permissions across updates.
	@# Order and flags matter:
	@#   1. Sparkle.framework first (--deep: it has its own nested XPC services
	@#      + Autoupdate/Updater helpers that must each be signed).
	@#   2. The daemon EXPLICITLY with a fixed identifier. It's a separate
	@#      Mach-O and the actual process that reads repos under ~/Documents,
	@#      so it's its own TCC subject. Left to --deep it gets a random
	@#      `bitwise-daemon-<hash>` id that changes every build — the bug that
	@#      made Full Disk Access on the app never cover it and re-prompt.
	@#   3. The outer app WITHOUT --deep, so it seals the already-signed nested
	@#      code by reference instead of re-stamping the daemon's identifier.
	codesign --force --deep --sign "$(SIGN_ID)" $(SIGN_CONT)/Frameworks/Sparkle.framework
	codesign --force --identifier com.cloovies.bitwise.daemon --sign "$(SIGN_ID)" $(SIGN_MACOS)/bitwise-daemon
	codesign --force --identifier com.cloovies.bitwise --sign "$(SIGN_ID)" $(SIGN_APP)
	@# Mirror the signed bundle into the repo so `make app` launches the
	@# same thing `make package` ships. The ditto target inherits iCloud
	@# xattrs but the signature is already sealed so Gatekeeper is fine.
	@mkdir -p $(MACOS_BUILD_DIR)
	rm -rf $(APP_BUNDLE)
	/usr/bin/ditto $(SIGN_APP) $(APP_BUNDLE)

# Zip the SIGNED .app from /tmp (clean, no stray xattrs) into build/release.
package: build-app
	@mkdir -p $(RELEASE_DIR)
	rm -f $(RELEASE_ZIP)
	cd $(SIGN_DIR) && /usr/bin/ditto -c -k --keepParent bitwise.app $(abspath $(RELEASE_ZIP))
	@echo "→ $(RELEASE_ZIP)"
	@du -h $(RELEASE_ZIP) | awk '{print "  size: " $$1}'

# Generate the EdDSA keypair Sparkle uses to sign updates. Run ONCE. The
# private key is stored in your login Keychain; the public key is printed for
# pasting into packaging/macos/Info.plist (SUPublicEDKey). The private key is
# never committed — it must stay secret.
sparkle-keys: sparkle
	$(SPARKLE_DIR)/bin/generate_keys

# Print the Sparkle public key (after sparkle-keys) for Info.plist.
sparkle-pubkey: sparkle
	$(SPARKLE_DIR)/bin/generate_keys -p

# Create the stable self-signed code-signing identity ($(SIGN_IDENTITY)) in the
# login Keychain. Run ONCE per build machine. Gives the app + daemon a constant
# designated requirement so macOS TCC permission grants (Documents / Full Disk)
# persist across updates instead of re-prompting every release (see SIGN_ID
# comment). Imported with -A so codesign can use the key without a GUI prompt;
# no Apple Developer account needed. Idempotent: no-op if the identity exists.
signing-identity:
	@if security find-certificate -c "$(SIGN_IDENTITY)" >/dev/null 2>&1; then \
	  echo "signing identity '$(SIGN_IDENTITY)' already present — nothing to do"; \
	else \
	  set -e; tmp=$$(mktemp -d); \
	  printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=$(SIGN_IDENTITY)\nO=Cloovies\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' > $$tmp/cs.cnf; \
	  openssl req -x509 -newkey rsa:2048 -keyout $$tmp/cs.key -out $$tmp/cs.crt -days 3650 -nodes -config $$tmp/cs.cnf; \
	  openssl pkcs12 -export -legacy -inkey $$tmp/cs.key -in $$tmp/cs.crt -out $$tmp/cs.p12 -passout pass:$(SIGN_IDENTITY) -name "$(SIGN_IDENTITY)"; \
	  security import $$tmp/cs.p12 -k $$HOME/Library/Keychains/login.keychain-db -P $(SIGN_IDENTITY) -A -T /usr/bin/codesign; \
	  rm -rf $$tmp; \
	  echo "created signing identity '$(SIGN_IDENTITY)'"; \
	fi

# Build the signed Sparkle appcast from the release zip, with enclosure URLs
# pointing at this version's GitHub release assets. Requires sparkle-keys.
appcast: sparkle
	@if [ -z "$(VERSION)" ]; then echo "Usage: make appcast VERSION=v0.1.0"; exit 1; fi
	$(SPARKLE_DIR)/bin/generate_appcast \
	  --download-url-prefix "https://github.com/$(RELEASE_REPO)/releases/download/$(VERSION)/" \
	  $(RELEASE_DIR)

# Cut a GitHub release. Usage: make release VERSION=v0.1.0
# Publishes to the PUBLIC distribution repo ($(RELEASE_REPO)) — NOT origin —
# because Sparkle must fetch the appcast + zip unauthenticated (see RELEASE_REPO
# comment above). If Sparkle keys are set up, also generates + attaches the
# signed appcast.xml. Without keys it ships the zip only and warns — auto-update
# stays off until keys exist. The git tag is created in the release repo; tag
# the source commit in origin separately for provenance (see RELEASING.md).
release: package
	@if [ -z "$(VERSION)" ]; then echo "Usage: make release VERSION=v0.1.0"; exit 1; fi
	@if $(SPARKLE_DIR)/bin/generate_keys -p >/dev/null 2>&1; then \
	  $(MAKE) --no-print-directory appcast VERSION=$(VERSION); \
	  gh release create $(VERSION) $(RELEASE_ZIP) $(RELEASE_DIR)/appcast.xml \
	    --repo $(RELEASE_REPO) \
	    --title "bitwise $(VERSION)" \
	    --notes "macOS app (Apple Silicon). **Install:** download \`bitwise-macos.zip\`, unzip, drag \`bitwise.app\` into **/Applications**, then **right-click it → Open → Open** (first launch only — it's ad-hoc signed, not notarized). Running it from /Applications matters: launching straight from Downloads triggers macOS App Translocation, which blocks auto-updates. After the first open, updates install themselves."; \
	else \
	  echo "⚠  Sparkle keys not set up (run 'make sparkle-keys') — releasing without appcast; auto-update disabled until keys exist."; \
	  gh release create $(VERSION) $(RELEASE_ZIP) \
	    --repo $(RELEASE_REPO) \
	    --title "bitwise $(VERSION)" \
	    --notes "macOS app (Apple Silicon). **Install:** download \`bitwise-macos.zip\`, unzip, drag \`bitwise.app\` into **/Applications**, then **right-click it → Open → Open** (first launch only — it's ad-hoc signed, not notarized). Running it from /Applications matters: launching straight from Downloads triggers macOS App Translocation, which blocks auto-updates. After the first open, updates install themselves."; \
	fi

# Regenerate the iconset + web favicon from packaging/macos/icon/gen-icon.go.
# The final .icns assembly (iconutil) happens inside build-app so the icon
# lives next to the Swift wrapper that will be signed, not in a stale cached
# copy in build/macos/.
icon:
	go run ./packaging/macos/icon/

# Launch the standalone workspace app.
app: workspace-app
	open build/macos/Cloovies.app

# Quit the running bitwise.app, rebuild it, relaunch. Convenience target for
# iterating on web/CSS: the .app embeds web/dist at compile time, so there's
# no hot-reload path — you have to rebuild and restart to see changes.
rebuild-legacy:
	-@osascript -e 'tell application "bitwise" to quit' >/dev/null 2>&1 || true
	-@pkill -x bitwise-daemon >/dev/null 2>&1 || true
	@sleep 1
	@$(MAKE) --no-print-directory build-app
	@open $(APP_BUNDLE) >/dev/null 2>&1 && echo "→ relaunched bitwise.app" || echo "→ built; relaunch manually"

# Install bitwise to ~/.local/bin
install: check-deps build-web
	go build -ldflags "$(REPO_LDFLAG)" -o $(HOME)/.local/bin/bitwise ./cmd/bitwise/

# Run all tests
test:
	go test ./... -v
	cd web && npx tsc --noEmit

clean:
	rm -rf bin/ web/dist/ build/ $(SIGN_DIR)

# The clean project/worktree/terminal workspace (no agent-scanner dependency).
.PHONY: workspace build-workspace workspace-app
workspace:
	go run ./cmd/workspace --web web/dist --port 4340

build-workspace: build-web
	go build -buildvcs=false -o bin/cloovies-workspace ./cmd/workspace

workspace-app:
	./scripts/build-workspace-app.sh

.PHONY: rebuild rebuild-legacy
rebuild:
	-@osascript -e 'tell application id "com.cloovies.workspace" to quit' >/dev/null 2>&1
	@$(MAKE) --no-print-directory workspace-app
	@open build/macos/Cloovies.app
