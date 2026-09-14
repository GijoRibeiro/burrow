package linear

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type WorktreeIssue struct {
	ID          string `json:"id"`
	Identifier  string `json:"identifier"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	State       struct {
		Name string `json:"name"`
	} `json:"state"`
}

type worktreeResponse struct {
	Data struct {
		Issue  *WorktreeIssue `json:"issue"`
		Issues struct {
			Nodes []WorktreeIssue `json:"nodes"`
		} `json:"issues"`
		Viewer struct {
			AssignedIssues struct {
				Nodes []WorktreeIssue `json:"nodes"`
			} `json:"assignedIssues"`
		} `json:"viewer"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

var issueIdentifier = regexp.MustCompile(`(?i)^[a-z][a-z0-9]*-[0-9]+$`)

// IssueReference accepts an identifier, UUID, or an issue link, never an arbitrary URL.
func IssueReference(value string) string {
	value = strings.TrimSpace(value)
	if u, err := url.Parse(value); err == nil && u.Host == "linear.app" && u.Scheme == "https" {
		parts := strings.Split(u.Path, "/")
		for i, part := range parts {
			if part == "issue" && i+1 < len(parts) {
				return parts[i+1]
			}
		}
	}
	return value
}

func SearchWorktreeIssues(key, query string) ([]WorktreeIssue, error) {
	query = IssueReference(query)
	if len(query) > 200 {
		return nil, errors.New("search must be 200 characters or fewer")
	}
	if issueIdentifier.MatchString(query) {
		issue, err := GetWorktreeIssue(key, query)
		if err != nil {
			return nil, err
		}
		return []WorktreeIssue{issue}, nil
	}
	var result worktreeResponse
	var q string
	vars := map[string]any{}
	const fields = `id identifier title url state { name }`
	if query == "" {
		q = `query WorktreeAssigned { viewer { assignedIssues(first: 50, filter: {state: {type: {nin: ["completed", "canceled"]}}}, orderBy: updatedAt) { nodes { ` + fields + ` } } } }`
	} else {
		q = `query WorktreeSearch($query: String!) { issues(first: 50, filter: {title: {containsIgnoreCase: $query}}, orderBy: updatedAt) { nodes { ` + fields + ` } } }`
		vars["query"] = query
	}
	if err := doGraphQL(key, q, vars, &result); err != nil {
		return nil, err
	}
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("Linear: %s", result.Errors[0].Message)
	}
	rows := result.Data.Issues.Nodes
	if query == "" {
		rows = result.Data.Viewer.AssignedIssues.Nodes
	}
	if rows == nil {
		rows = []WorktreeIssue{}
	}
	return rows, nil
}

func GetWorktreeIssue(key, reference string) (WorktreeIssue, error) {
	var result worktreeResponse
	q := `query WorktreeIssue($id: String!) { issue(id: $id) { id identifier title url description state { name } } }`
	if err := doGraphQL(key, q, map[string]any{"id": IssueReference(reference)}, &result); err != nil {
		return WorktreeIssue{}, err
	}
	if len(result.Errors) > 0 {
		return WorktreeIssue{}, fmt.Errorf("Linear: %s", result.Errors[0].Message)
	}
	if result.Data.Issue == nil || result.Data.Issue.ID == "" {
		return WorktreeIssue{}, errors.New("Linear issue not found")
	}
	issue := *result.Data.Issue
	u, err := url.Parse(issue.URL)
	if err != nil || u.Scheme != "https" || u.Host != "linear.app" {
		return WorktreeIssue{}, errors.New("Linear returned an invalid issue link")
	}
	return issue, nil
}
