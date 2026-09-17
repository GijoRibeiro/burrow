package workspace

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestLiveSlackComplaintScan(t *testing.T) {
	if os.Getenv("CLOOVIES_LIVE_SLACK") != "1" {
		t.Skip("explicit live Slack smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	report, err := runComplaintScan(ctx, t.TempDir(), complaintPrompt(ComplaintSettings{Channels: "product-questions, kyc-cc"}, time.Now().Add(-24*time.Hour))+" For this smoke test return at most three concrete findings and keep searches bounded. Acknowledge any scope limit in complete/summary.")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.MarshalIndent(report, "", "  ")
	if err := os.WriteFile("/tmp/burrow-slack-live-report.json", data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("Slack scanner returned %d findings; complete=%v; error=%s", len(report.Findings), report.Complete, report.Error)
	if report.Error != "" {
		t.Fatal(report.Error)
	}
}
