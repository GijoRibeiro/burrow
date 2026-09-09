> This document describes the legacy Bitwise app and its separate release repository. For the current workspace app, use `make workspace-app` as described in [README.md](README.md).

# Releasing bitwise & shipping updates

This is the runbook for cutting a new release of the macOS app and getting it
to users via the in-app auto-updater. Read the whole thing once; after that the
**[Quick release](#quick-release)** section is all you need.

> Audience: anyone (human or agent) publishing a bitwise build. Assumes you're
> on the build Mac with the repo cloned, `gh` authenticated as `GijoRibeiro`,
> and the Sparkle signing key already in the login Keychain (see
> [One-time setup](#one-time-setup) to verify).

---

## How the update system works

bitwise updates itself with **[Sparkle](https://sparkle-project.org/)** (v2.9.2,
vendored under `third_party/sparkle/`, gitignored). On launch the app
(`app/main.swift`) creates an `SPUStandardUpdaterController`, which reads two
keys from `packaging/macos/Info.plist`:

- **`SUFeedURL`** — where to fetch the *appcast* (an RSS feed listing the latest
  version + download URL + signature).
- **`SUPublicEDKey`** — the Ed25519 public key. Every downloaded update must be
  signed by the matching private key or Sparkle refuses it.

### Two repos, on purpose

| Repo | Visibility | Holds |
|------|-----------|-------|
| `GijoRibeiro/bitwise` (`origin`) | **private** | source code |
| `GijoRibeiro/bitwise-releases` | **public** | release zips + `appcast.xml` |

**Why split them?** GitHub release assets on a *private* repo return **404 to
unauthenticated clients**. Sparkle fetches the appcast and zip with no auth, so
if the feed lived in the private repo every user would get
*"error occurred in retrieving update information."* The public `bitwise-releases`
repo exists solely to host the feed + binaries so Sparkle can reach them. The
source stays private.

So `SUFeedURL` points at:
```
https://github.com/GijoRibeiro/bitwise-releases/releases/latest/download/appcast.xml
```
The `/releases/latest/download/<asset>` path is a stable redirect to whatever the
newest non-draft, non-prerelease release is — so the URL never changes between
versions.

### Signing — two different signatures, don't confuse them

1. **Sparkle update signature (Ed25519 / EdDSA).** Proves an update came from
   you. Private key in the **login Keychain** (created once via
   `make sparkle-keys`); public key pasted into `Info.plist` as `SUPublicEDKey`.
   `make appcast` signs each zip and writes the signature into `appcast.xml`.
2. **Apple code signature (codesign).** We **ad-hoc sign** (`codesign --sign -`)
   — free, no Apple Developer account, no notarization. The tradeoff: first
   launch shows the *"cannot be verified"* Gatekeeper dialog, which users clear
   with **right-click → Open** (or the README one-liner). Auto-updates after the
   first launch don't re-prompt.

---

## Quick release

From a clean working tree on the build Mac:

```bash
# 1. Commit + push your source changes to the PRIVATE repo first.
git add -A && git commit -m "..."        # if you have changes
git push origin main

# 2. Cut the release (builds, signs, publishes to bitwise-releases).
make release VERSION=v0.3.0              # use the next semver, leading v

# 3. Tag the source commit in origin for provenance (optional but recommended).
git tag v0.3.0 && git push origin v0.3.0

# 4. Verify the public feed is live (see Verification below).
```

That's it. Existing users on a Sparkle-enabled build (v0.2.0+) will be offered
the update automatically within ~24h, or immediately via **bitwise menu →
Check for Updates…**.

---

## What `make release VERSION=vX.Y.Z` does

Defined in the `Makefile` (`release` → `package` → `build-app` + `appcast`):

1. **`build-app`** — builds the Go daemon (`bin/bitwise`) and the Swift wrapper,
   embeds `Sparkle.framework`, stamps `vX.Y.Z` into `CFBundleVersion` /
   `CFBundleShortVersionString`, assembles `bitwise.app` in `/tmp/cloovies-build`
   (outside iCloud — see the `SIGN_DIR` comment in the Makefile), ad-hoc signs
   it, and dittos it into `build/macos/`.
2. **`package`** — zips the signed `.app` → `build/release/bitwise-macos.zip`.
3. **`appcast`** — runs Sparkle's `generate_appcast`, which signs the zip with
   the Keychain private key and writes `build/release/appcast.xml` with the
   enclosure URL pointing at `bitwise-releases/releases/download/vX.Y.Z/`.
4. **`gh release create`** — publishes `vX.Y.Z` to **`bitwise-releases`** (via
   `--repo $(RELEASE_REPO)`) with both `bitwise-macos.zip` and `appcast.xml`
   attached. The git tag is created in the release repo.

The release repo (`RELEASE_REPO`) is set near the top of the `Makefile`.

---

## Verification (do this every release)

The auto-updater silently breaks if the feed isn't *publicly* reachable, so
always confirm with an **unauthenticated** fetch (what Sparkle actually does —
not `gh`, which is authenticated and will succeed even on a broken/private feed):

```bash
# Feed must be HTTP 200 and list the version you just shipped.
curl -sSL "https://github.com/GijoRibeiro/bitwise-releases/releases/latest/download/appcast.xml" \
  -o /tmp/appcast.xml -w "feed HTTP %{http_code}\n"
cat /tmp/appcast.xml          # check <sparkle:version> and the enclosure url

# Zip must also be HTTP 200.
curl -sSL "https://github.com/GijoRibeiro/bitwise-releases/releases/latest/download/bitwise-macos.zip" \
  -o /dev/null -w "zip HTTP %{http_code}\n"
```

> GitHub's download CDN can lag a few seconds right after upload. If you get a
> 404 immediately after releasing, wait ~30s and retry before assuming a real
> problem.

Then in the app: **bitwise menu → Check for Updates…** should say *you're up to
date* (when running the version you just shipped) — not an error dialog.

---

## How users get the app

**First install (manual, one time):**
1. Download `bitwise-macos.zip` from
   <https://github.com/GijoRibeiro/bitwise-releases/releases/latest>.
2. Unzip, drag `bitwise.app` to `/Applications`.
3. First launch: macOS says it "cannot be verified" (we ad-hoc sign, not
   notarized). **Right-click the app → Open → Open**, once. Or run:
   ```bash
   xattr -dr com.apple.quarantine /Applications/bitwise.app
   ```

**After that — automatic.** Sparkle checks the feed on a schedule
(`SUEnableAutomaticChecks` is on) and offers updates in-app. No manual download
needed for subsequent versions.

---

## One-time setup (already done — here for reference / new machines)

These are already configured; you only redo them on a fresh build machine.

- **Sparkle key pair** — `make sparkle-keys` (stores the private key in the
  login Keychain, prints the public key). Run **once, ever** — regenerating
  invalidates every shipped app's `SUPublicEDKey`.
  - Verify the key is present: `third_party/sparkle/bin/generate_keys -p`
    should print the public key. It must equal `SUPublicEDKey` in
    `packaging/macos/Info.plist` (currently
    `slb0tUNW23xKelcQ+Tw6SzcqxfopRH+BtcqTu4jFXN0=`).
- **Public releases repo** — created via
  `gh repo create GijoRibeiro/bitwise-releases --public`. `RELEASE_REPO` in the
  `Makefile` and `SUFeedURL` in `Info.plist` both point at it.
- **`gh` auth** — `gh auth status` must show `GijoRibeiro` logged in.

---

## Troubleshooting

| Symptom (dialog) | Cause | Fix |
|---|---|---|
| **"The updater failed to start."** | `SUPublicEDKey` in the *built* bundle isn't a valid 32-byte Ed25519 key (e.g. a stale build made before the key was set, still carrying the `REPLACE_WITH_…` placeholder). | Rebuild: `make build-app`. Confirm with `/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" build/macos/bitwise.app/Contents/Info.plist` then `… | base64 -D | wc -c` → must be **32**. |
| **"An error occurred in retrieving update information."** | Feed not publicly reachable: appcast missing from the latest release, release is a draft/prerelease, or it was published to the **private** repo. | Confirm the unauthenticated `curl` above returns 200. Ensure the release is in `bitwise-releases`, not `bitwise`, and has `appcast.xml` attached. |
| Update found but **download fails / signature rejected** | The zip wasn't signed with the key matching `SUPublicEDKey`, or `appcast.xml` was hand-edited. | Re-run `make release` so `generate_appcast` re-signs. Don't edit `appcast.xml` by hand. |
| Update never offered | Running app's version ≥ appcast version (correct — nothing newer), or automatic checks throttled. | Bump `VERSION` to something newer, or use **Check for Updates…** to force a check. |

---

## Gotchas & notes

- **Always release to `bitwise-releases`, never `origin`.** `make release` does
  this automatically (`--repo $(RELEASE_REPO)`); only matters if you ever run
  `gh release create` by hand.
- **Rebuild after touching `Info.plist`.** `SUFeedURL` / `SUPublicEDKey` are
  baked into the bundle at build time. A shipped app uses the values it was
  built with, not whatever's in the repo now.
- **Arch.** Builds are for the architecture of the build Mac (currently
  `arm64` — see `sparkle:hardwareRequirements` in the appcast). Apple-Silicon
  users are covered; Intel users would need a separate `x86_64` build.
- **iCloud + codesign.** The repo lives in iCloud-synced `~/Documents`, whose
  file provider adds xattrs that break `codesign`. That's why the build
  assembles and signs in `/tmp/cloovies-build` and dittos the sealed bundle
  back. Don't move the signing step into the repo tree.
- **Source tags are provenance only.** The release tag lives in
  `bitwise-releases`. Tag the matching source commit in `origin` yourself
  (step 3 of Quick release) if you want to know which commit shipped — Sparkle
  doesn't care.
