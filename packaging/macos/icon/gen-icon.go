package main

import (
	"image"
	"image/png"
	"log"
	"os"
)

func main() {
	const srcPath = "web/assets/sprites/Grook-1.png"
	f, err := os.Open(srcPath)
	if err != nil {
		log.Fatalf("open %s: %v", srcPath, err)
	}
	defer f.Close()
	src, err := png.Decode(f)
	if err != nil {
		log.Fatalf("decode: %v", err)
	}

	// Pad 15x15 → 16x16 (top-left anchored; last row/col transparent).
	padded := image.NewRGBA(image.Rect(0, 0, 16, 16))
	sb := src.Bounds()
	for y := 0; y < sb.Dy(); y++ {
		for x := 0; x < sb.Dx(); x++ {
			padded.Set(x, y, src.At(sb.Min.X+x, sb.Min.Y+y))
		}
	}

	const iconsetDir = "build/macos/icon.iconset"
	if err := os.MkdirAll(iconsetDir, 0o755); err != nil {
		log.Fatal(err)
	}
	targets := []struct {
		name string
		size int
	}{
		{"icon_16x16.png", 16},
		{"icon_16x16@2x.png", 32},
		{"icon_32x32.png", 32},
		{"icon_32x32@2x.png", 64},
		{"icon_128x128.png", 128},
		{"icon_128x128@2x.png", 256},
		{"icon_256x256.png", 256},
		{"icon_256x256@2x.png", 512},
		{"icon_512x512.png", 512},
		{"icon_512x512@2x.png", 1024},
	}
	for _, t := range targets {
		writeScaled(padded, t.size, iconsetDir+"/"+t.name)
	}

	if err := os.MkdirAll("web/public", 0o755); err != nil {
		log.Fatal(err)
	}
	writeScaled(padded, 64, "web/public/favicon.png")

	log.Printf("generated %d iconset PNGs + favicon.png from %s", len(targets), srcPath)
}

func writeScaled(src *image.RGBA, size int, outPath string) {
	base := src.Bounds().Dx()
	scale := size / base
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		sy := y / scale
		for x := 0; x < size; x++ {
			sx := x / scale
			dst.Set(x, y, src.At(sx, sy))
		}
	}
	f, err := os.Create(outPath)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, dst); err != nil {
		log.Fatal(err)
	}
}
