package chat

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func SaveTempImage(b64 string, index int) (string, error) {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("decode base64: %w", err)
	}
	dir := filepath.Join(os.TempDir(), "cloovies-images")
	os.MkdirAll(dir, 0755)
	path := filepath.Join(dir, fmt.Sprintf("image-%d.png", index))
	if err := os.WriteFile(path, data, 0644); err != nil {
		return "", fmt.Errorf("write temp image: %w", err)
	}
	return path, nil
}

func BuildImageCLIArgs(cwd string, sessionID string, imagePaths []string, message string) []string {
	if message == "" {
		message = "describe this image"
	}
	args := []string{"-p", message, "--output-format", "text"}
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	} else {
		args = append(args, "--continue", "--cwd", cwd)
	}
	for _, p := range imagePaths {
		args = append(args, "--file", p)
	}
	return args
}

func SendWithImages(cwd string, sessionID string, images []string, message string, responseFn func(string)) error {
	var paths []string
	for i, b64 := range images {
		p, err := SaveTempImage(b64, i)
		if err != nil {
			return err
		}
		paths = append(paths, p)
	}
	defer func() {
		for _, p := range paths {
			os.Remove(p)
		}
	}()

	args := BuildImageCLIArgs(cwd, sessionID, paths, message)
	cmd := exec.Command("claude", args...)
	cmd.Dir = cwd

	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("claude error: %w — %s", err, string(out))
	}

	responseFn(string(out))
	return nil
}
