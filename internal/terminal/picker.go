// Package terminal inspects an agent's tmux pane to detect interactive
// states that don't make it into the JSONL session file.
//
// The most useful one is "agent is waiting on a permission / choice
// picker": Claude Code stops mid-turn and prompts the user with a
// numbered list, but the prompt is purely terminal UI — the JSONL
// shows a tool_use without a tool_result, indistinguishable from a
// long-running shell command. Pattern-matching the visible pane gives
// us a precise signal that the user is needed.
package terminal

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/gijo/cloovies/internal/chat"
)

// PickerOption is one numbered choice on a Claude Code picker.
// Description holds the indented explanatory line(s) under the title
// (AskUserQuestion options have these); empty for plain pickers. Checked
// is the current checkbox state on a multi-select picker.
type PickerOption struct {
	Number      int    `json:"number"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	// IsCheckbox is true when this option had a checkbox glyph — i.e. it's a
	// toggle, not an immediate action. In a multi-select picker, plain action
	// options ("Type something", "Chat about this") have IsCheckbox=false.
	IsCheckbox bool `json:"isCheckbox,omitempty"`
	Checked    bool `json:"checked,omitempty"`
}

// Picker is the parsed structure of a Claude Code picker as seen
// in the agent's tmux pane. Cursor is the 1-indexed option the
// chevron is currently on (0 = couldn't tell). The frontend renders
// this directly so the user can answer the picker from inside
// Cloovies instead of context-switching to the terminal.
type Picker struct {
	Question string         `json:"question"`
	Options  []PickerOption `json:"options"`
	Cursor   int            `json:"cursor"`
	// MultiSelect is true when options carry checkbox glyphs ([ ]/[✓]),
	// meaning the user toggles several then submits, rather than picking one.
	MultiSelect bool `json:"multiSelect,omitempty"`
	// Preview is the right-column panel some pickers draw beside the options
	// (a content/diff preview of what the decision affects), captured verbatim
	// so the web can mirror it in monospace. Empty for plain pickers.
	Preview string `json:"preview,omitempty"`
}

// optionLineRe matches a numbered option line, optionally led by a
// chevron cursor. Capture groups: 1) cursor glyph (or empty), 2)
// option number, 3) option label up to end of line.
var optionLineRe = regexp.MustCompile(`^\s*([❯›▶>])?\s*(\d+)\.\s+(.+?)\s*$`)

// pickerFooterRe is the unique footer that confirms we're looking at
// a Claude Code picker rather than a stray numbered list. Two markers:
//
//   - "Enter to select" — the standard navigation hint shown under
//     permission prompts and AskUserQuestion option pickers.
//   - "Ready to submit your answers" — the hardcoded confirmation
//     prompt at the end of an AskUserQuestion flow ("1. Submit
//     answers / 2. Cancel"). This screen does NOT show the "Enter to
//     select" hint, so without this second pattern the picker scanner
//     misses the submit step entirely and the agent never lights up
//     as awaiting-choice for the final confirmation.
var pickerFooterRe = regexp.MustCompile(`Enter to select|Ready to submit your answers`)

// ParsePicker extracts the picker structure from a tmux pane capture.
// Returns nil when the pane isn't showing a picker (no footer
// hint or no parseable options). The footer hint is required —
// without it we'd false-positive on agent output containing
// numbered lists ("1. Do X. 2. Do Y."). Designed to be conservative:
// when in doubt, return nil and let the user fall back to the
// terminal.
func ParsePicker(pane string) *Picker {
	if !pickerFooterRe.MatchString(pane) {
		return nil
	}
	lines := strings.Split(pane, "\n")

	var options []PickerOption
	cursor := 0
	firstOpt := -1
	multiSelect := false
	for i, line := range lines {
		m := optionLineRe.FindStringSubmatch(line)
		if m == nil {
			// Continuation line: an indented, non-empty line directly
			// under an option is that option's description (AskUserQuestion
			// options carry one or two). Footer hints and box borders are
			// excluded so they don't get slurped into the description.
			if len(options) > 0 {
				trimmed := strings.TrimSpace(line)
				if trimmed != "" && line != trimmed &&
					!pickerFooterRe.MatchString(line) &&
					!boxBorderRe.MatchString(trimmed) &&
					isDescriptionText(trimmed) {
					last := &options[len(options)-1]
					if last.Description == "" {
						last.Description = trimmed
					} else {
						last.Description += " " + trimmed
					}
				}
			}
			continue
		}
		num, err := strconv.Atoi(m[2])
		if err != nil {
			continue
		}
		label := strings.TrimSpace(m[3])
		// Some pickers draw a diff preview / side panel to the RIGHT of the
		// option label using box-drawing glyphs. That's terminal graphics,
		// not part of the label — cut it off so the title stays clean.
		label = stripTrailingDrawing(label)
		// Skip empty labels; some terminals re-emit the cursor row
		// at end-of-buffer with just "1." and no text.
		if label == "" {
			continue
		}
		// Multi-select options lead with a checkbox glyph ([ ]/[✓]). Pull
		// the checked state off and strip the glyph from the label.
		checked, stripped, isCheckbox := parseCheckbox(label)
		if isCheckbox {
			multiSelect = true
			label = stripped
		}
		// A numbered run that restarts (num <= the previous option's number)
		// means what we collected so far was numbered PROSE above the picker —
		// the agent's read-out, a list in its message, etc. Claude Code picker
		// options are a single 1..N run, so the real picker is this fresh run.
		// Drop the earlier matches and start over from here.
		if len(options) > 0 && num <= options[len(options)-1].Number {
			options = options[:0]
			cursor = 0
			firstOpt = -1
		}
		if m[1] != "" {
			cursor = num
		}
		if firstOpt < 0 {
			firstOpt = i
		}
		options = append(options, PickerOption{Number: num, Label: label, IsCheckbox: isCheckbox, Checked: checked})
	}
	if len(options) == 0 {
		return nil
	}

	// Pull the question from the lines just above the first option.
	// Claude Code wraps the question inside a Unicode box:
	//
	//   ╭────────────────────────────────────────╮
	//   │ Tool use                               │
	//   │                                        │
	//   │ Do you want to allow this command?     │
	//   │                                        │
	//   │ Command: ls -la                        │
	//   ╰────────────────────────────────────────╯
	//   ❯ 1. Yes
	//     2. No
	//
	// Each inner line is `│ <text> │` with padding. We need to:
	//   - skip pure border rows (╭─╮ ╰─╯ and bare horizontal rules)
	//   - strip the leading/trailing │ and surrounding whitespace
	//     from content rows, leaving the actual text
	//   - drop blank inner rows (`│        │`)
	//   - keep walking past blanks; the question is usually the
	//     last non-blank inner row before the box closes, but
	//     headers like "Tool use" and footers like "Command: ..."
	//     surround it. Walk the whole box and join — context is
	//     cheap, missing question is the actual failure mode.
	question := extractQuestion(lines, firstOpt)

	// Bound the preview scan at the footer hint line so trailing chrome
	// ("Enter to select…", "Notes: press n…") isn't pulled into the panel.
	endIdx := len(lines)
	for i := firstOpt; i < len(lines); i++ {
		if pickerEndRe.MatchString(lines[i]) {
			endIdx = i
			break
		}
	}

	return &Picker{
		Question:    question,
		Options:     options,
		Cursor:      cursor,
		MultiSelect: multiSelect,
		Preview:     extractPreview(lines, firstOpt, endIdx),
	}
}

// pickerEndRe marks the end of the picker block — the footer hint line(s).
// Used to bound the preview-column scan so trailing chrome isn't captured.
var pickerEndRe = regexp.MustCompile(`Enter to select|Ready to submit your answers|to navigate|Esc to cancel|press \S+ to add notes`)

// isDrawingRune reports whether r is a box-drawing / block-element glyph or a
// bare vertical bar — the characters that make up a picker's preview panel.
func isDrawingRune(r rune) bool {
	return (r >= 0x2500 && r <= 0x259F) || r == '|'
}

// extractPreview pulls the right-column preview panel (the box-drawn content
// some pickers render beside the options) out of the pane, verbatim, so the
// web can mirror it in monospace. It finds the leftmost column where panel
// drawing begins across the option region, then slices every line at that
// column — leaving the left-column option labels behind. Returns "" when there
// is no panel (a panel must span ≥2 rows and sit in a right-hand column).
func extractPreview(lines []string, firstOpt, endIdx int) string {
	colStart := -1
	rows := 0
	for i := firstOpt; i < endIdx && i < len(lines); i++ {
		for j, c := range []rune(lines[i]) {
			if isDrawingRune(c) {
				rows++
				if colStart < 0 || j < colStart {
					colStart = j
				}
				break
			}
		}
	}
	if colStart < 1 || rows < 2 {
		return ""
	}
	var out []string
	for i := firstOpt; i < endIdx && i < len(lines); i++ {
		rs := []rune(lines[i])
		if len(rs) <= colStart {
			continue
		}
		seg := strings.TrimRight(string(rs[colStart:]), " ")
		if strings.TrimSpace(seg) == "" {
			continue
		}
		out = append(out, seg)
	}
	return strings.Join(out, "\n")
}

// panelBoundaryRe marks where a right-hand preview column begins — the point
// to cut a label / reject a description at. Two forms:
//
//   - any box-drawing / block-element glyph (Unicode U+2500–U+259F), which
//     Claude Code uses to draw diff previews and side panels; and
//   - an ASCII '|' sitting behind a ≥2-space gutter, the way a column
//     separator is offset from the text.
//
// The gutter requirement is the fix for a regression: a plain `[…|]` class
// also matched an INLINE pipe in option text ("sort | uniq", "Pipe ( | )"),
// truncating real labels — sometimes to nothing, which dropped the option and
// made the whole picker fail to parse. Real preview columns are drawn with the
// box-drawing '│' (U+2502), so an inline ASCII '|' in text is never graphics.
var panelBoundaryRe = regexp.MustCompile(`[\x{2500}-\x{259F}]|\s{2,}\|`)

// noiseRe matches non-prose hint fragments that appear around rich pickers —
// collapsed-diff markers ("14 lines hidden") and key hints ("press n to add
// notes") — which must not be captured as an option description.
var noiseRe = regexp.MustCompile(`\d+ lines? hidden|press \S+ to `)

// stripTrailingDrawing removes a trailing preview-column run (box-drawing
// panel or gutter-offset '|') from an option label, leaving the clean title.
func stripTrailingDrawing(label string) string {
	if loc := panelBoundaryRe.FindStringIndex(label); loc != nil {
		label = label[:loc[0]]
	}
	return strings.TrimSpace(label)
}

// isDescriptionText reports whether a continuation line is real prose worth
// showing as a description, rather than preview-panel graphics or a key hint.
func isDescriptionText(s string) bool {
	return !panelBoundaryRe.MatchString(s) && !noiseRe.MatchString(s)
}

// checkboxRe matches a multi-select option's leading checkbox glyph:
// "[ ] Label", "[✓] Label", "[x] Label". Group 1 is the inner glyph,
// group 2 is the remaining label text.
var checkboxRe = regexp.MustCompile(`^\[([ xX✓✗])\]\s+(.+)$`)

// parseCheckbox splits a leading checkbox glyph off an option label.
// Returns the checked state, the label with the glyph removed, and whether
// a checkbox was present at all (which marks the picker as multi-select).
func parseCheckbox(label string) (checked bool, stripped string, ok bool) {
	m := checkboxRe.FindStringSubmatch(label)
	if m == nil {
		return false, label, false
	}
	c := m[1]
	checked = c == "x" || c == "X" || c == "✓"
	return checked, strings.TrimSpace(m[2]), true
}

// boxBorderRe matches a row that's entirely box-drawing characters and
// whitespace — i.e. a top/bottom border like `╭─────╮` or `╰─────╯`,
// or a bare horizontal rule. These rows carry no question text and
// must be skipped during extraction.
var boxBorderRe = regexp.MustCompile(`^[\s╭╮╰╯─━═]+$`)

// boxSideRe captures the inner content of a `│ ... │` row, tolerating
// alternate vertical-bar glyphs and ANY whitespace inside. Group 1 is
// the trimmed inner content.
var boxSideRe = regexp.MustCompile(`^\s*[│┃|]\s?(.*?)\s?[│┃|]\s*$`)

// extractQuestion walks back from the first picker option line and
// reconstructs the question text from Claude Code's boxed prompt
// shape. Skips border rows, strips `│` sides, drops blank inner
// lines, and stops when it hits the top of the box (`╭─...─╮`) or
// runs out of lines / hits a non-box plain line that signals we've
// scrolled past the prompt. Multi-line questions are space-joined.
//
// We accept up to 8 inner content lines so questions wrapped to
// several lines or surrounded by header/footer rows ("Tool use",
// "Command: foo") all show up — the user can see context. Anything
// more than 8 is almost certainly noise.
//
// Failure mode this guards against: when the box's top border is
// missing from the visible pane (long question that scrolled, or
// previous-turn content sitting flush against the box), the old
// "plain line above the picker" fallback kept slurping unrelated
// text and showed it as the question. Once any box-side line has
// been consumed we LOCK to box mode and stop on the first
// non-box / non-border line — even if that means we lose a single
// scrolled-off line, that's strictly better than rendering the
// previous turn as the prompt.
func extractQuestion(lines []string, firstOpt int) string {
	var inner []string
	sawBoxContent := false
	for i := firstOpt - 1; i >= 0 && len(inner) < 8; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			// Blank row OUTSIDE the box ends the search; inside
			// the box, blanks just separate question / context.
			if len(inner) == 0 {
				continue
			}
			break
		}
		if boxBorderRe.MatchString(trimmed) {
			// Top border of the prompt block — stop here.
			if strings.ContainsAny(trimmed, "╭╮") {
				break
			}
			// Bottom border (right above the options) — skip.
			continue
		}
		if m := boxSideRe.FindStringSubmatch(trimmed); m != nil {
			sawBoxContent = true
			content := strings.TrimSpace(m[1])
			if content == "" {
				continue
			}
			inner = append([]string{content}, inner...)
			continue
		}
		// Plain (non-boxed) line. Two cases:
		//   1) We've already started collecting box content — this
		//      line is OUTSIDE / ABOVE the box. Stop; do not slurp
		//      the previous turn's output as the question.
		//   2) We've seen no box yet — Claude's AskUserQuestion prompts
		//      are NOT boxed and the question wraps across several lines.
		//      Collect each plain line and keep walking up; the blank-line
		//      check at the top of the loop stops us at the gap above the
		//      question, so we get the whole prompt without slurping the
		//      previous turn.
		if sawBoxContent {
			break
		}
		inner = append([]string{trimmed}, inner...)
		continue
	}
	return strings.Join(inner, " ")
}

// Claude Code pickers all share the same shape: a numbered list with
// a chevron cursor on the active option, plus a footer hint line.
// Examples (taken from real prompts):
//
//	❯ 1. Yes
//	  2. Yes, and don't ask again this session
//	  3. No, and tell Claude what to do differently (esc)
//	Enter to select · ↑/↓ to navigate · Esc to cancel
//
// Two independent signals — either is enough on its own:
//
//  1. A line starting with one of the chevron glyphs Claude Code
//     uses (`❯` U+276F, `›` U+203A, `▶` U+25B6, or plain `>`)
//     followed by a numbered option. The character that gets
//     rendered varies by font / terminal — `›` and `❯` look almost
//     identical but are different code points, and the original
//     regex only matched the heavy variant, which is why the
//     scanner missed real pickers.
//
//  2. The literal footer hint text "Enter to select". This string
//     is unique to Claude Code's interactive picker — no shell
//     prompt, build log, or tool output produces it organically —
//     so matching it has effectively zero false-positive risk and
//     covers the case where the cursor scrolled offscreen but the
//     picker is still active at the bottom.
var pickerRe = regexp.MustCompile(`(?m)^\s*[❯›▶>]\s*\d+\.|Enter to select`)

// PickerRegex returns the source pattern used to detect picker
// prompts. Exposed for diagnostics so the debug endpoint can show
// the user what shape we're matching against.
func PickerRegex() string {
	return pickerRe.String()
}

// CapturePane returns the visible contents of the agent's tmux pane,
// whether the picker regex matched, and any error encountered along
// the resolve → capture chain. Used by both HasPickerPrompt (in the
// scan loop) and the /api/debug/picker endpoint (for live
// inspection — "is the regex finding the prompt or not?").
//
// Errors are returned for diagnostics; the scan-loop wrapper
// swallows them. Empty `paneOut` with err != nil means we couldn't
// find a tmux pane for this pid (no tmux session, dead pid, etc.).
func CapturePane(pid int) (paneOut string, matched bool, err error) {
	if pid <= 0 {
		return "", false, errors.New("invalid pid")
	}
	ttyPath, err := chat.FindTTY(pid)
	if err != nil {
		return "", false, fmt.Errorf("find tty: %w", err)
	}
	paneID, err := chat.FindTmuxPane(ttyPath)
	if err != nil {
		return "", false, fmt.Errorf("find tmux pane: %w", err)
	}
	// `capture-pane -p` writes the visible portion of the pane to
	// stdout (no scrollback). That's exactly the screen the user
	// would see — pickers always sit at the bottom of the visible
	// area so we don't need history.
	out, err := exec.Command("tmux", "capture-pane", "-p", "-t", paneID).Output()
	if err != nil {
		return "", false, fmt.Errorf("capture-pane: %w", err)
	}
	return string(out), pickerRe.Match(out), nil
}

// HasPickerPrompt returns true when the agent's tmux pane currently
// shows a Claude Code picker. Best-effort: if tmux isn't running, the
// pane can't be located, or capture fails, returns false (no error)
// — the caller treats absence of a signal as "no picker".
func HasPickerPrompt(pid int) bool {
	_, matched, err := CapturePane(pid)
	if err != nil {
		return false
	}
	return matched
}
