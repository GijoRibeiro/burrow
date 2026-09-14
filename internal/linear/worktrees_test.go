package linear

import "testing"

func TestIssueReference(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{" ENG-42 ", "ENG-42"}, {"https://linear.app/team/issue/ENG-42/fix-menu#comment", "ENG-42"}, {"https://evil.test/issue/ENG-42", "https://evil.test/issue/ENG-42"},
	} {
		if got := IssueReference(tc.input); got != tc.want {
			t.Fatalf("%q: got %q", tc.input, got)
		}
	}
}
