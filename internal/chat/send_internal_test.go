package chat

import "testing"

func TestEscapeAppleScript(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "hello world", "hello world"},
		{"double_quote", `say "hi"`, `say \"hi\"`},
		{"backslash", `foo\bar`, `foo\\bar`},
		{"backslash_then_quote", `\"`, `\\\"`},
		{"newline_lf", "line1\nline2", `line1\nline2`},
		{"newline_crlf", "line1\r\nline2", `line1\r\nline2`},
		{"tab", "col1\tcol2", `col1\tcol2`},
		{"empty", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := escapeAppleScript(c.in)
			if got != c.want {
				t.Errorf("escapeAppleScript(%q)\n  got  = %q\n  want = %q", c.in, got, c.want)
			}
		})
	}
}

func TestAvoidTrailingBackslash(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"no_backslash", "hello world", "hello world"},
		{"trailing_backslash", `fix it?\`, `fix it?\ `},
		{"multiple_trailing_backslashes", `foo\\`, `foo\\ `},
		{"backslash_in_middle", `a\b`, `a\b`},
		{"empty", "", ""},
		{"only_backslash", `\`, `\ `},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := avoidTrailingBackslash(c.in)
			if got != c.want {
				t.Errorf("avoidTrailingBackslash(%q)\n  got  = %q\n  want = %q", c.in, got, c.want)
			}
		})
	}
}
