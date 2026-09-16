package workspace

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthDoesNotWaitForWorkspaceOperations(t *testing.T) {
	m := &Manager{}
	m.mu.Lock()
	defer m.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		m.Handler().ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1/api/workspace/health", nil))
		done <- response
	}()
	select {
	case response := <-done:
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"service":"cloovies-workspace"`) {
			t.Fatalf("unexpected readiness: %d %s", response.Code, response.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("readiness waited for the workspace")
	}
}
