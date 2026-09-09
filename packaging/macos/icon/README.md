# App icon

The bitwise app icon is generated from a single source sprite:

- **Source:** `web/assets/sprites/Grook-1.png` (15×15 pixel-art beholder)
- **Generator:** `gen-icon.go` (Go stdlib only — nearest-neighbor upscale, no dependencies)
- **Outputs:**
  - `build/macos/bitwise.app/Contents/Resources/AppIcon.icns` (macOS dock / Finder)
  - `web/public/favicon.png` (browser tab)

## Regenerate

```
make icon
```

That runs `gen-icon.go`, then `iconutil -c icns` to assemble the `.icns`.

## Change the creature

Edit the `srcPath` constant at the top of `gen-icon.go` to point at a different
sprite in `web/assets/sprites/`, then `make icon`.
