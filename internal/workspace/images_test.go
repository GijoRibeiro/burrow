package workspace

import (
	"bytes"
	"image"
	"image/png"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestTerminalImage(t *testing.T) {
	root := t.TempDir()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	write := func(path string, body []byte) {
		t.Helper()
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "screen shot.png"), data.Bytes())
	write(filepath.Join(root, "fake.png"), []byte("<html>not an image</html>"))
	outside := filepath.Join(t.TempDir(), "outside.png")
	write(outside, data.Bytes())
	if err := os.Symlink(outside, filepath.Join(root, "escape.png")); err != nil {
		t.Fatal(err)
	}
	m := &Manager{state: State{Terminals: []Terminal{{ID: "preview", Path: root}}}}
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"screen shot.png", 200}, {filepath.Join(root, "screen shot.png"), 200}, {"fake.png", 415}, {"missing.png", 404}, {outside, 404}, {"../outside.png", 404}, {"escape.png", 404}, {".", 404}, {"", 400},
	} {
		t.Run(tc.path, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/image?path="+url.QueryEscape(tc.path), nil)
			r.SetPathValue("id", "preview")
			w := httptest.NewRecorder()
			m.terminalImage(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
			if tc.status == 200 && (w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), data.Bytes())) {
				t.Fatal("image bytes or type changed")
			}
		})
	}
	r := httptest.NewRequest("GET", "/image?path=screen%20shot.png", nil)
	r.SetPathValue("id", "unknown")
	w := httptest.NewRecorder()
	m.terminalImage(w, r)
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
}
