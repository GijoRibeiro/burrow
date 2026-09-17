package workspace

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Images are served only from the terminal's checkout. os.Root prevents both
// path traversal and symlink escapes, including replacement during the request.
func (m *Manager) terminalImage(w http.ResponseWriter, r *http.Request) {
	terminal, err := m.Terminal(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" || len(path) > 4096 {
		http.Error(w, "invalid image path", http.StatusBadRequest)
		return
	}
	rootPath, err := filepath.EvalSymlinks(terminal.Path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if filepath.IsAbs(path) {
		// macOS commonly reports /tmp or /var aliases for /private paths.
		path, err = filepath.EvalSymlinks(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		// Only this terminal's uploaded attachments extend the checkout boundary.
		if m.file != "" {
			if uploads, resolveErr := filepath.EvalSymlinks(m.imageUploadDir(terminal.ID)); resolveErr == nil {
				if relative, relErr := filepath.Rel(uploads, path); relErr == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
					rootPath = uploads
				}
			}
		}
		path, err = filepath.Rel(rootPath, path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	file, err := root.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if info.Size() > 24<<20 {
		http.Error(w, "image is too large to preview", http.StatusRequestEntityTooLarge)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, (24<<20)+1))
	if err != nil || len(data) > 24<<20 {
		http.Error(w, "image could not be read", http.StatusRequestEntityTooLarge)
		return
	}
	kind := http.DetectContentType(data)
	switch kind {
	case "image/png", "image/jpeg", "image/gif":
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || int64(config.Width)*int64(config.Height) > 32_000_000 {
			http.Error(w, "image cannot be previewed", http.StatusUnsupportedMediaType)
			return
		}
	case "image/webp":
	default:
		http.Error(w, "preview supports PNG, JPEG, GIF, and WebP images", http.StatusUnsupportedMediaType)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=2")
	http.ServeContent(w, r, info.Name(), info.ModTime(), bytes.NewReader(data))
}
