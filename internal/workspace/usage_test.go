package workspace

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUsageSelectsFableAndApplicableSharedLimits(t *testing.T) {
	u := parseClaudeUsage([]byte(`{"limits":[
		{"kind":"session","percent":9,"resets_at":"2026-09-21T16:30:00Z","scope":null},
		{"kind":"weekly_all","percent":63,"scope":null},
		{"kind":"weekly_scoped","percent":100,"scope":{"model":{"display_name":"Fable"},"surface":null}},
		{"kind":"weekly_scoped","percent":98,"scope":{"model":{"display_name":"Opus"}}},
		{"kind":"weekly_scoped","percent":99,"scope":{"model":{"display_name":"Sonnet"}}},
		{"kind":"weekly_scoped","percent":97,"scope":{"model":{"display_name":"Fable"},"surface":"cowork"}}
	]}`))
	if u.Status != "ready" || u.Shared || len(u.Windows) != 3 || u.Windows[2].Used != 100 {
		t.Fatalf("wrong applicable limits: %+v", u)
	}
	data, _ := json.Marshal(u)
	if strings.Contains(string(data), "Opus") || strings.Contains(string(data), "Sonnet") {
		t.Fatal(string(data))
	}
	u = parseClaudeUsage([]byte(`{"five_hour":{"utilization":2},"seven_day":{"utilization":41},"seven_day_opus":{"utilization":99}}`))
	if u.Status != "ready" || !u.Shared || len(u.Windows) != 2 {
		t.Fatalf("legacy shared limits: %+v", u)
	}
	u = parseClaudeUsage([]byte(`{"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Fable"}}}]}`))
	if u.Status != "unavailable" {
		t.Fatal("missing percentage must not mean zero usage")
	}
}

func TestUsageSelectsAstraWithoutOtherModelBuckets(t *testing.T) {
	u := parseCodexUsage([]byte(`{"rateLimitsByLimitId":{
		"codex":{"limitId":"codex","primary":{"usedPercent":9,"windowDurationMins":10080,"resetsAt":1790584837}},
		"gpt-6-astra":{"limitId":"gpt-6-astra","primary":{"usedPercent":32,"windowDurationMins":300}},
		"other":{"limitId":"other","primary":{"usedPercent":100}}
	}}`))
	if u.Status != "ready" || u.Shared || len(u.Windows) != 2 || u.Windows[0].Used != 9 || u.Windows[1].Used != 32 {
		t.Fatalf("wrong buckets: %+v", u)
	}
	u = parseCodexUsage([]byte(`{"rateLimits":{"limitId":"codex","primary":{"usedPercent":9,"windowDurationMins":10080}}}`))
	if u.Status != "ready" || !u.Shared || len(u.Windows) != 1 {
		t.Fatalf("missing shared bucket: %+v", u)
	}
	for _, data := range []string{`{}`, `null`, `{"rateLimits":{"limitId":"other","primary":{"usedPercent":0}}}`, `{"rateLimits":{"limitId":"codex","primary":{}}}`} {
		if parseCodexUsage([]byte(data)).Status != "unavailable" {
			t.Fatalf("invented allowance for %s", data)
		}
	}
}

func TestCodexUsageRPCIsReadOnlyAndBounded(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\nread init\ncase \"$init\" in *initialize*) ;; *) exit 1;; esac\nprintf '%s\\n' '{\"id\":0,\"result\":{}}'\nread notification\nread request\ncase \"$request\" in *account/rateLimits/read*) ;; *) exit 1;; esac\nprintf '%s\\n' '{\"id\":1,\"result\":{\"rateLimits\":{\"limitId\":\"codex\",\"primary\":{\"usedPercent\":17,\"windowDurationMins\":10080}}}}'\nread anything_else\n"
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	u := readCodexUsage(ctx)
	if u.Status != "ready" || u.Windows[0].Used != 17 {
		t.Fatalf("RPC result: %+v", u)
	}
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("#!/bin/sh\nread first\nread second\n"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx2, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	start := time.Now()
	if readCodexUsage(ctx2).Status != "unavailable" || time.Since(start) > time.Second {
		t.Fatal("RPC did not stop at deadline")
	}
}

func TestClaudeUsageRespectsConfiguredAccount(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if token, err := claudeAccountToken(context.Background()); err == nil || token != "" {
		t.Fatal("must not read another account's keychain")
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(`{"claudeAiOauth":{"accessToken":"fixture-token"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if token, err := claudeAccountToken(context.Background()); err != nil || token != "fixture-token" {
		t.Fatal("configured account was not read")
	}
}
