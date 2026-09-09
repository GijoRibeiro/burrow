package chat_test

import (
	"encoding/base64"
	"os"
	"testing"

	"github.com/gijo/cloovies/internal/chat"
)

func TestSaveImage(t *testing.T) {
	pngData := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
		0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x36, 0x28, 0x19,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
		0x44, 0xae, 0x42, 0x60, 0x82,
	}
	b64 := base64.StdEncoding.EncodeToString(pngData)

	path, err := chat.SaveTempImage(b64, 0)
	if err != nil {
		t.Fatalf("SaveTempImage error: %v", err)
	}
	defer os.Remove(path)

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("temp file not created: %v", err)
	}

	data, _ := os.ReadFile(path)
	if len(data) != len(pngData) {
		t.Errorf("expected %d bytes, got %d", len(pngData), len(data))
	}
}

func TestBuildImageCLIArgs(t *testing.T) {
	args := chat.BuildImageCLIArgs("/proj/foo", "sess-123", []string{"/tmp/a.png", "/tmp/b.png"}, "describe these")
	expected := []string{"-p", "describe these", "--output-format", "text", "--resume", "sess-123", "--file", "/tmp/a.png", "--file", "/tmp/b.png"}
	if len(args) != len(expected) {
		t.Fatalf("expected %d args, got %d: %v", len(expected), len(args), args)
	}
	for i, e := range expected {
		if args[i] != e {
			t.Errorf("arg[%d]: expected %q, got %q", i, e, args[i])
		}
	}
}

func TestBuildImageCLIArgsNoSession(t *testing.T) {
	args := chat.BuildImageCLIArgs("/proj/foo", "", []string{"/tmp/a.png"}, "")
	found := false
	for _, a := range args {
		if a == "describe this image" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected default message, got: %v", args)
	}
	// Should use --continue when no session
	foundContinue := false
	for _, a := range args {
		if a == "--continue" {
			foundContinue = true
		}
	}
	if !foundContinue {
		t.Errorf("expected --continue flag when no sessionID, got: %v", args)
	}
}
