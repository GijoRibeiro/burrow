package workspace

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestImageUploadAndIsolation(t *testing.T) {
	dir := t.TempDir()
	checkout := t.TempDir()
	m := &Manager{file: filepath.Join(dir, "workspace.json"), state: State{Terminals: []Terminal{{ID: "one", Path: checkout}, {ID: "two", Path: checkout}}}}
	var valid bytes.Buffer
	if err := png.Encode(&valid, image.NewRGBA(image.Rect(0, 0, 24, 16))); err != nil {
		t.Fatal(err)
	}
	upload := func(id string, data []byte) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string][]byte{"data": data})
		r := httptest.NewRequest("POST", "/images", bytes.NewReader(body))
		r.SetPathValue("id", id)
		w := httptest.NewRecorder()
		m.uploadImage(w, r)
		return w
	}
	if w := upload("missing", valid.Bytes()); w.Code != 404 {
		t.Fatal(w.Code)
	}
	for _, data := range [][]byte{[]byte("<svg onload='alert(1)'></svg>"), valid.Bytes()[:40], make([]byte, (8<<20)+1)} {
		if w := upload("one", data); w.Code < 400 {
			t.Fatal("invalid image accepted")
		}
	}
	w := upload("one", valid.Bytes())
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response struct{ Path string }
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(response.Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("attachment not private", info.Mode())
	}
	if files, _ := os.ReadDir(checkout); len(files) != 0 {
		t.Fatal("upload dirtied checkout")
	}
	for _, id := range []string{"one", "two"} {
		r := httptest.NewRequest("GET", "/image?path="+url.QueryEscape(response.Path), nil)
		r.SetPathValue("id", id)
		w := httptest.NewRecorder()
		m.terminalImage(w, r)
		if id == "one" && (w.Code != 200 || !bytes.Equal(w.Body.Bytes(), valid.Bytes())) {
			t.Fatal("owner cannot preview", w.Code)
		}
		if id == "two" && w.Code != 404 {
			t.Fatal("other terminal can read upload", w.Code)
		}
	}
	// A symlink inside the upload directory must not expose arbitrary files.
	outside := filepath.Join(t.TempDir(), "secret.png")
	os.WriteFile(outside, valid.Bytes(), 0600)
	escape := filepath.Join(filepath.Dir(response.Path), "escape.png")
	os.Symlink(outside, escape)
	r := httptest.NewRequest("GET", "/image?path="+url.QueryEscape(escape), nil)
	r.SetPathValue("id", "one")
	w = httptest.NewRecorder()
	m.terminalImage(w, r)
	if w.Code != 404 {
		t.Fatal("upload symlink escape", w.Code)
	}
}
