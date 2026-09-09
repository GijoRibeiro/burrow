package terminal

import (
	"strings"
	"testing"
)

// Boxed picker — typical Claude Code permission prompt. extractQuestion
// should pull the contents of the box, not chat output above it.
func TestParsePicker_BoxedQuestion(t *testing.T) {
	pane := strings.Join([]string{
		"Some unrelated chat output from a previous turn.",
		"Tool result: ls returned 3 files.",
		"",
		"╭────────────────────────────────────────╮",
		"│ Tool use                               │",
		"│                                        │",
		"│ Do you want to allow this command?     │",
		"╰────────────────────────────────────────╯",
		"❯ 1. Yes",
		"  2. No",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if !strings.Contains(p.Question, "Do you want to allow this command?") {
		t.Errorf("question missing actual prompt: %q", p.Question)
	}
	if strings.Contains(p.Question, "previous turn") || strings.Contains(p.Question, "Tool result") {
		t.Errorf("question leaked stale chat output: %q", p.Question)
	}
}

// Regression: when the box's top border is missing from the visible pane
// (e.g., the question is long enough that the top scrolled off, or
// previous-turn content sits directly above the box with no blank
// separator), the parser must NOT slurp the previous turn's text as
// the question. Today it does — extractQuestion's "plain (non-boxed)
// line above the picker" fallback keeps accumulating past the box
// content into unrelated prior output.
func TestParsePicker_NoTopBorder_DoesNotLeakPreviousTurn(t *testing.T) {
	pane := strings.Join([]string{
		"Calling Gmail 3 times… (ctrl+o to expand)",
		"   ⎿  \"from:contact subject:Login is:unread\"",
		"· Asking clarifying questions… (8m 33s)",
		"  ⎿  ◼ Ask clarifying questions one at a time",
		"     ◻ Propose 2-3 approaches with recommendation",
		"│ Do you want to send this email?        │",
		"╰────────────────────────────────────────╯",
		"❯ 1. Yes",
		"  2. No",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if !strings.Contains(p.Question, "Do you want to send this email?") {
		t.Errorf("question missing actual prompt: %q", p.Question)
	}
	leaks := []string{"Calling Gmail", "Asking clarifying", "Propose 2-3"}
	for _, leak := range leaks {
		if strings.Contains(p.Question, leak) {
			t.Errorf("question leaked %q from previous turn: %q", leak, p.Question)
		}
	}
}

// Picker without any box — Claude's rating prompts use a single line
// led by '●'. Today the parser also fails to detect these because the
// option format is "1: Bad" (colon) not "1. Bad" (period). Captured
// here for completeness but skipped until we widen option-line regex.
func TestParsePicker_RatingPrompt_PlainLine(t *testing.T) {
	t.Skip("rating-prompt format ('1: Bad   2: Fine') not yet supported")
}

// #1 — AskUserQuestion prompts are NOT boxed and the question wraps across
// several lines. The parser must reconstruct the whole question, not just
// the last wrapped line, and must still stop at the blank line above it so
// it doesn't slurp the previous turn.
func TestParsePicker_MultiLineQuestion_NonBoxed(t *testing.T) {
	pane := strings.Join([]string{
		"Some previous turn output that must not leak.",
		"",
		"Is there a design/copy reference I should work from, or should I",
		"propose the reworked versions for you to react to?",
		"",
		"1. Figma design",
		"2. Written copy/spec",
		"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	for _, want := range []string{
		"Is there a design/copy reference I should work from",
		"propose the reworked versions for you to react to?",
	} {
		if !strings.Contains(p.Question, want) {
			t.Errorf("question missing %q; got %q", want, p.Question)
		}
	}
	if strings.Contains(p.Question, "previous turn output") {
		t.Errorf("question leaked previous turn: %q", p.Question)
	}
}

// #2 — Each AskUserQuestion option carries an indented description line under
// its numbered title. The parser must capture it into Option.Description and
// keep the title clean.
func TestParsePicker_OptionDescriptions(t *testing.T) {
	pane := strings.Join([]string{
		"What kind of reference should I use?",
		"",
		"1. Figma design",
		"   There's a figma file for these emails. I'll pull it via MCP.",
		"2. Written copy/spec",
		"   You have the new copy or a spec. Point me to it.",
		"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if len(p.Options) != 2 {
		t.Fatalf("expected 2 options, got %d: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Label != "Figma design" {
		t.Errorf("option 1 label = %q, want clean title", p.Options[0].Label)
	}
	if !strings.Contains(p.Options[0].Description, "pull it via MCP") {
		t.Errorf("option 1 description missing; got %q", p.Options[0].Description)
	}
	if !strings.Contains(p.Options[1].Description, "Point me to it") {
		t.Errorf("option 2 description missing; got %q", p.Options[1].Description)
	}
}

// #3 — Multi-select prompts lead each option label with a checkbox glyph.
// The parser must flag the picker MultiSelect, set Checked per option, and
// strip the glyph from the displayed label.
func TestParsePicker_MultiSelect_Checkboxes(t *testing.T) {
	pane := strings.Join([]string{
		"What kind of rework do you have in mind for these three emails?",
		"",
		"1. [✓] Copywriting",
		"2. [ ] Visual/layout",
		"3. [ ] Data shown",
		"Enter to select · Space to toggle · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if !p.MultiSelect {
		t.Errorf("expected MultiSelect = true")
	}
	if len(p.Options) != 3 {
		t.Fatalf("expected 3 options, got %d", len(p.Options))
	}
	if p.Options[0].Label != "Copywriting" || p.Options[1].Label != "Visual/layout" {
		t.Errorf("labels not stripped of checkbox glyph: %+v", p.Options)
	}
	if !p.Options[0].Checked {
		t.Errorf("option 1 should be Checked")
	}
	if p.Options[1].Checked || p.Options[2].Checked {
		t.Errorf("options 2,3 should be unchecked: %+v", p.Options)
	}
	for i, o := range p.Options {
		if !o.IsCheckbox {
			t.Errorf("option %d should be a checkbox: %+v", i+1, o)
		}
	}
}

// #3 (mixed) — a multi-select also offers plain action options with no
// checkbox ("Type something", "Chat about this"). Those toggle nothing; the
// UI must submit them immediately, so they need IsCheckbox = false while the
// real checkbox options stay IsCheckbox = true.
func TestParsePicker_MultiSelect_MixedActionOptions(t *testing.T) {
	pane := strings.Join([]string{
		"What kind of rework do you have in mind?",
		"",
		"1. [✓] Copywriting",
		"2. [ ] Visual/layout",
		"3. Type something",
		"4. Chat about this",
		"Enter to select · Space to toggle · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if !p.MultiSelect {
		t.Errorf("expected MultiSelect = true")
	}
	wantCheckbox := []bool{true, true, false, false}
	for i, want := range wantCheckbox {
		if p.Options[i].IsCheckbox != want {
			t.Errorf("option %d IsCheckbox = %v, want %v (%+v)", i+1, p.Options[i].IsCheckbox, want, p.Options[i])
		}
	}
	if p.Options[2].Label != "Type something" || p.Options[3].Label != "Chat about this" {
		t.Errorf("action option labels wrong: %+v", p.Options)
	}
}

// #2 (regression) — some pickers draw a diff preview / side panel with
// box-drawing glyphs and key hints ("14 lines hidden", "press n to add
// notes") next to or under the options. None of that is a description: it
// must not leak into Option.Description, and trailing box-drawing must not
// leak into the label either. When in doubt, show the clean title only.
func TestParsePicker_DoesNotCaptureDrawingAsDescription(t *testing.T) {
	pane := strings.Join([]string{
		"That will work okay for both.",
		"",
		"The grey schedule box showed status we can no longer trust. How should the neutral version handle it?",
		"",
		"❯ 1. Drop the box (Recommended)        ┌──────────────────────────┐",
		"     │                              │",
		"  2. Keep box, neutral content    ├──×── 14 lines hidden ──────────┤",
		"     │                          │   Notes: press n to add notes",
		"Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if len(p.Options) != 2 {
		t.Fatalf("expected 2 options, got %d: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Label != "Drop the box (Recommended)" {
		t.Errorf("option 1 label leaked drawing: %q", p.Options[0].Label)
	}
	if p.Options[1].Label != "Keep box, neutral content" {
		t.Errorf("option 2 label leaked drawing: %q", p.Options[1].Label)
	}
	for i, o := range p.Options {
		if o.Description != "" {
			t.Errorf("option %d captured drawing/noise as description: %q", i+1, o.Description)
		}
	}
	if !strings.Contains(p.Question, "How should the neutral version handle it?") {
		t.Errorf("question missing: %q", p.Question)
	}
}

// Rework — rich pickers put a preview panel in a RIGHT column beside the
// options (the content the decision is about). Clean option titles go in
// Options (left column); the preview panel is captured verbatim into
// Picker.Preview (right column) so the web can mirror it in monospace.
func TestParsePicker_TwoColumnPreview_Mirror(t *testing.T) {
	// pad the left column to a fixed width so the preview panel aligns at a
	// known column, mirroring how Claude Code lays the two columns out.
	pad := func(left, right string) string {
		const w = 38
		for len([]rune(left)) < w {
			left += " "
		}
		return left + right
	}
	pane := strings.Join([]string{
		"How should we handle the 'Please note' legal text?",
		"",
		pad("❯ 1. Drop pre-payment, keep §22", "┌ Please note ─────────────────┐"),
		pad("  2. Remove the whole note", "│ Now that the statutory       │"),
		pad("  3. Rewrite the whole copy", "│ cancellation period ended,   │"),
		pad("", "│ withdrawal only per §22.     │"),
		pad("", "│ (no mention of pre-payments) │"),
		pad("", "└──────────────────────────────┘"),
		"Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if len(p.Options) != 3 {
		t.Fatalf("expected 3 options, got %d: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Label != "Drop pre-payment, keep §22" {
		t.Errorf("option 1 label leaked preview column: %q", p.Options[0].Label)
	}
	// Preview must carry the panel content...
	for _, want := range []string{"Please note", "Now that the statutory", "no mention of pre-payments"} {
		if !strings.Contains(p.Preview, want) {
			t.Errorf("preview missing %q; got:\n%s", want, p.Preview)
		}
	}
	// ...and must NOT contain the option labels (those are the left column).
	if strings.Contains(p.Preview, "Drop pre-payment") || strings.Contains(p.Preview, "Remove the whole note") {
		t.Errorf("preview leaked option labels:\n%s", p.Preview)
	}
}

// Bug — the agent often writes a NUMBERED prose read-out above the picker
// ("1. The pre-payment claim… 2. The §22 clause…"). Those are not picker
// options. The real options are the run that restarts at 1 just above the
// footer; we must keep only that run, not every "N." line in the pane.
func TestParsePicker_IgnoresNumberedProseAbovePicker(t *testing.T) {
	pane := strings.Join([]string{
		"Here's my read of the content. The note is really two things:",
		"1. The pre-payment claim — this is the harmful bit.",
		"2. The §22 / Appendix B withdrawal clause — legitimate legal info.",
		"",
		"How should we handle the 'Please note' legal text?",
		"",
		"❯ 1. Drop pre-payment, keep §22",
		"  2. Remove the whole note",
		"  3. Rewrite the whole copy",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if len(p.Options) != 3 {
		t.Fatalf("expected 3 options (the real picker), got %d: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Label != "Drop pre-payment, keep §22" {
		t.Errorf("first option should be the picker's, not prose: %q", p.Options[0].Label)
	}
	if strings.Contains(p.Question, "pre-payment claim") || strings.Contains(p.Question, "read of the content") {
		t.Errorf("question leaked the prose read-out: %q", p.Question)
	}
	if !strings.Contains(p.Question, "How should we handle the 'Please note' legal text?") {
		t.Errorf("question wrong: %q", p.Question)
	}
}

// AskUserQuestion's submit confirmation step has no "Enter to select"
// footer — just the hardcoded "Ready to submit your answers?" prompt
// above a 1. Submit / 2. Cancel picker. The parser must still detect
// this so the agent surfaces as awaiting-choice for the final step.
func TestParsePicker_AskUserQuestion_SubmitConfirmation(t *testing.T) {
	pane := strings.Join([]string{
		"← ⊠ AT toggle  ⊠ Asset step  ✓ Submit  →",
		"",
		"Review your answers",
		"",
		"● How should the Austria localization be exposed?",
		"   → Country pill (DE / AT) next to lang",
		"● How should the asset step behave?",
		"   → Free multi-select with approximate costs (Recommended)",
		"",
		"Ready to submit your answers?",
		"",
		"❯ 1. Submit answers",
		"  2. Cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker for AskUserQuestion submit step, got nil")
	}
	if len(p.Options) != 2 {
		t.Fatalf("expected 2 options, got %d", len(p.Options))
	}
	if p.Options[0].Label != "Submit answers" || p.Options[1].Label != "Cancel" {
		t.Errorf("unexpected options: %+v", p.Options)
	}
	if p.Cursor != 1 {
		t.Errorf("expected cursor on option 1, got %d", p.Cursor)
	}
	if !strings.Contains(p.Question, "Ready to submit your answers") {
		t.Errorf("question should include submit prompt, got %q", p.Question)
	}
}

// Bug — stripTrailingDrawing treated the bare ASCII '|' as terminal graphics,
// so an option whose label contains an inline pipe ("sort | uniq", "Pipe ( | )")
// got truncated at the first pipe — sometimes down to nothing, which drops the
// option and can make the whole picker fail to parse. Real pickers draw their
// preview column with Unicode box-drawing (│ U+2502), not ASCII '|', so an
// inline '|' in option text must survive intact.
func TestParsePicker_OptionLabelKeepsInlinePipe(t *testing.T) {
	pane := strings.Join([]string{
		"Which delimiter should the export use?",
		"",
		"❯ 1. Pipe ( | )",
		"  2. Run `sort | uniq -c`",
		"  3. Comma",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
	}, "\n")

	p := ParsePicker(pane)
	if p == nil {
		t.Fatalf("expected picker, got nil")
	}
	if len(p.Options) != 3 {
		t.Fatalf("expected 3 options, got %d: %+v", len(p.Options), p.Options)
	}
	if p.Options[0].Label != "Pipe ( | )" {
		t.Errorf("inline pipe truncated: got %q want %q", p.Options[0].Label, "Pipe ( | )")
	}
	if p.Options[1].Label != "Run `sort | uniq -c`" {
		t.Errorf("inline pipe truncated: got %q want %q", p.Options[1].Label, "Run `sort | uniq -c`")
	}
}
