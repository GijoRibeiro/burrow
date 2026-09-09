package cloovies

import "embed"

//go:embed web/dist
var EmbeddedWeb embed.FS

// Sprites are embedded directly from source rather than via web/dist because
// Vite only copies what gets imported, and sprites are loaded dynamically via
// /api/creatures → /assets/sprites/<name>-<n>.png at runtime.
//
//go:embed web/assets/sprites
var EmbeddedSprites embed.FS
