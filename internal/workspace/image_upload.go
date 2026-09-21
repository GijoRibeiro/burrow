package workspace

import (
	"bytes"
	"encoding/json"
	"image"
	"net/http"
	"os"
	"path/filepath"
)

// Attachments live outside checkouts so pasting a screenshot never dirties Git.
// Each terminal has its own read boundary, including for later transcript previews.
func (m *Manager) imageUploadDir(id string) string {
	return filepath.Join(filepath.Dir(m.file), "attachments", id)
}

func (m *Manager) uploadImage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := m.Terminal(id); err != nil {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
	var payload struct {
		Data []byte `json:"data"`
	}
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(&payload); err != nil || len(payload.Data) > 8<<20 {
		http.Error(w, "Choose an image smaller than 8 MB", http.StatusBadRequest)
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(payload.Data))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 32_000_000 {
		http.Error(w, "Choose a PNG, JPEG, or GIF image up to 32 megapixels", http.StatusUnsupportedMediaType)
		return
	}
	// Decode fully before exposing the file to the agent (not just its header).
	if _, _, err = image.Decode(bytes.NewReader(payload.Data)); err != nil {
		http.Error(w, "The image is damaged or incomplete", http.StatusUnsupportedMediaType)
		return
	}
	dir := m.imageUploadDir(id)
	if err = os.MkdirAll(dir, 0700); err != nil {
		respond(w, nil, err)
		return
	}
	file, err := os.CreateTemp(dir, "image-*."+format)
	if err != nil {
		respond(w, nil, err)
		return
	}
	_, err = file.Write(payload.Data)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(file.Name())
		respond(w, nil, err)
		return
	}
	path, err := canonical(file.Name())
	respond(w, map[string]string{"path": path}, err)
}
