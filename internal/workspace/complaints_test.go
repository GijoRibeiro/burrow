package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func complaintManager(t *testing.T) *Manager {
	t.Helper()
	return &Manager{file: filepath.Join(t.TempDir(), "workspace.json")}
}
func awaitComplaintScan(t *testing.T, m *Manager) ComplaintState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s, e := m.Complaints()
		if e != nil {
			t.Fatal(e)
		}
		if !s.Running {
			return s
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatal("scan did not finish")
	return ComplaintState{}
}
func TestComplaintSourceValidationAndReviewPersistence(t *testing.T) {
	m := complaintManager(t)
	s, err := m.Complaints()
	if err != nil {
		t.Fatal(err)
	}
	if s.Settings.Enabled {
		t.Fatal("hourly scan must be opt-in")
	}
	good := Complaint{Title: "Mobile document clipped", Quote: "Document is cut off", Summary: "KYC viewer clips documents on phones.", Area: "KYC", URL: "https://example.slack.com/archives/C123/p123456789?thread_ts=1"}
	now := time.Now().UTC()
	mergeComplaints(&s, []Complaint{good}, now)
	for _, url := range []string{"javascript:alert(1)", "https://example.slack.com.evil.test/archives/C123/p1", "https://example.slack.com/anything", "https://user@example.slack.com/archives/C1/p1", "http://example.slack.com/archives/C1/p1"} {
		bad := good
		bad.URL = url
		mergeComplaints(&s, []Complaint{bad}, now)
	}
	if len(s.Findings) != 1 {
		t.Fatalf("invalid source accepted: %d", len(s.Findings))
	}
	if strings.Contains(s.Findings[0].URL, "?") {
		t.Fatal("URL not canonical")
	}
	m.complaints.state = s
	if err := m.ReviewComplaint(s.Findings[0].ID, "reviewed"); err != nil {
		t.Fatal(err)
	}
	m.complaints.mu.Lock()
	mergeComplaints(&m.complaints.state, []Complaint{good}, now.Add(time.Hour))
	err = m.saveComplaintsLocked()
	m.complaints.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	restored := &Manager{file: m.file}
	got, err := restored.Complaints()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Findings) != 1 || got.Findings[0].Status != "reviewed" || !got.Findings[0].FoundAt.Equal(now) {
		t.Fatalf("dedupe lost review state: %+v", got)
	}
	stat, err := os.Stat(filepath.Join(filepath.Dir(m.file), "complaints.json"))
	if err != nil {
		t.Fatal(err)
	}
	if stat.Mode().Perm() != 0600 {
		t.Fatal("findings must be private")
	}
	if m.ReviewComplaint(s.Findings[0].ID, "unknown") == nil {
		t.Fatal("invalid status accepted")
	}
}
func TestComplaintScanRejectsOverlapAndCancels(t *testing.T) {
	m := complaintManager(t)
	started := make(chan struct{})
	m.complaints.run = func(ctx context.Context, dir, prompt string) (ComplaintReport, error) {
		close(started)
		<-ctx.Done()
		return ComplaintReport{}, ctx.Err()
	}
	if err := m.ScanComplaints(); err != nil {
		t.Fatal(err)
	}
	<-started
	if m.ScanComplaints() == nil {
		t.Fatal("overlapping scan accepted")
	}
	m.CancelComplaintScan()
	s := awaitComplaintScan(t, m)
	if s.Running || !strings.Contains(s.Error, "canceled") || !s.LastSuccess.IsZero() {
		t.Fatalf("bad canceled state: %+v", s)
	}
}
func TestComplaintScopeChangeDuringScanDoesNotSkipNewChannels(t *testing.T) {
	m := complaintManager(t)
	release := make(chan struct{})
	m.complaints.run = func(context.Context, string, string) (ComplaintReport, error) {
		<-release
		return ComplaintReport{Complete: true}, nil
	}
	if err := m.ScanComplaints(); err != nil {
		t.Fatal(err)
	}
	if err := m.ConfigureComplaints(ComplaintSettings{Channels: "new-channel"}); err != nil {
		t.Fatal(err)
	}
	close(release)
	s := awaitComplaintScan(t, m)
	if !s.LastSuccess.IsZero() {
		t.Fatal("old scope scan advanced new scope cursor")
	}
	m.complaints.run = func(context.Context, string, string) (ComplaintReport, error) {
		return ComplaintReport{Complete: true}, nil
	}
	if err := m.ScanComplaints(); err != nil {
		t.Fatal(err)
	}
	s = awaitComplaintScan(t, m)
	if s.LastSuccess.IsZero() {
		t.Fatal("successful scan did not advance cursor")
	}
}
func TestComplaintPartialAndInterruptedScansRemainVisible(t *testing.T) {
	m := complaintManager(t)
	m.complaints.run = func(context.Context, string, string) (ComplaintReport, error) {
		return ComplaintReport{Summary: "Partial coverage"}, nil
	}
	if err := m.ScanComplaints(); err != nil {
		t.Fatal(err)
	}
	s := awaitComplaintScan(t, m)
	if s.Error == "" || !s.LastSuccess.IsZero() {
		t.Fatal("partial scan presented as complete")
	}
	m.complaints.state.Running = true
	if err := m.saveComplaintsLocked(); err != nil {
		t.Fatal(err)
	}
	restored := &Manager{file: m.file}
	s, err := restored.Complaints()
	if err != nil {
		t.Fatal(err)
	}
	if s.Running || !strings.Contains(s.Error, "interrupted") {
		t.Fatal("interrupted scan stuck running")
	}
}
func TestComplaintRunnerRequiresStructuredOutput(t *testing.T) {
	for _, data := range []string{`garbage`, `{"result":"I found some"}`, `{"is_error":true,"structured_output":{}}`} {
		if _, err := parseComplaintOutput([]byte(data)); err == nil {
			t.Fatal("accepted invalid result")
		}
	}
	r, err := parseComplaintOutput([]byte(`{"structured_output":{"complete":true,"summary":"Searched chosen channels","error":"","findings":[]}}`))
	if err != nil || !r.Complete {
		t.Fatal(r, err)
	}
}

func TestComplaintScheduleStartsDueScanAndShutdownCancelsIt(t *testing.T) {
	m := complaintManager(t)
	if err := m.ConfigureComplaints(ComplaintSettings{Enabled: true, Channels: "product"}); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	m.complaints.run = func(ctx context.Context, _ string, _ string) (ComplaintReport, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return ComplaintReport{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.StartComplaintMonitor(ctx)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("due hourly scan did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not stop scheduled scan")
	}
	s := awaitComplaintScan(t, m)
	if !s.LastSuccess.IsZero() {
		t.Fatal("canceled scan advanced cursor")
	}
}
