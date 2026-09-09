// Package linear is a tiny Linear GraphQL client used to back the
// assigned-tickets panel in the web UI. Scope is intentionally narrow:
// authenticate with a personal API key, fetch the current user's open
// issues, return them grouped-ready by status, and move an issue to a
// different workflow state.
package linear

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"
)

const endpoint = "https://api.linear.app/graphql"

// Issue is the flattened shape the frontend consumes.
type Issue struct {
	ID          string  `json:"id"`
	Identifier  string  `json:"identifier"` // e.g. "ENG-123"
	Title       string  `json:"title"`
	URL         string  `json:"url"`
	Priority    int     `json:"priority"` // 0 none, 1 urgent, 2 high, 3 medium, 4 low
	StateID     string  `json:"stateId"`
	StatusName  string  `json:"statusName"`
	StatusType  string  `json:"statusType"` // backlog | unstarted | started | completed | canceled | triage
	StatusColor string  `json:"statusColor"`
	TeamID      string  `json:"teamId"`
	TeamKey     string  `json:"teamKey"`
	SortOrder   float64 `json:"sortOrder"` // Linear manual order; lower = higher in list
}

// State is a single workflow state on a team, keyed by ID.
type State struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Color    string  `json:"color"`
	Position float64 `json:"position"`
}

// FetchResult carries issues plus per-team workflow states, so the frontend
// can resolve "move to In Progress" → a concrete state ID belonging to the
// issue's team without a second round-trip.
type FetchResult struct {
	Issues     []Issue            `json:"issues"`
	TeamStates map[string][]State `json:"teamStates"` // teamID → states
}

type gqlResponse struct {
	Data struct {
		Viewer struct {
			AssignedIssues struct {
				Nodes []struct {
					ID         string  `json:"id"`
					Identifier string  `json:"identifier"`
					Title      string  `json:"title"`
					URL        string  `json:"url"`
					Priority   int     `json:"priority"`
					SortOrder  float64 `json:"sortOrder"`
					State      struct {
						ID    string `json:"id"`
						Name  string `json:"name"`
						Type  string `json:"type"`
						Color string `json:"color"`
					} `json:"state"`
					Team struct {
						ID     string `json:"id"`
						Key    string `json:"key"`
						States struct {
							Nodes []struct {
								ID       string  `json:"id"`
								Name     string  `json:"name"`
								Type     string  `json:"type"`
								Color    string  `json:"color"`
								Position float64 `json:"position"`
							} `json:"nodes"`
						} `json:"states"`
					} `json:"team"`
				} `json:"nodes"`
			} `json:"assignedIssues"`
		} `json:"viewer"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// assignedQuery fetches issues + the full workflow-state list for each team
// an issue belongs to. Workflow states per team are small (usually <10), so
// inlining them with the issues avoids an extra roundtrip when the user
// drag-moves a card.
//
// We pull `sortOrder` so we can mirror Linear's manual ordering. The
// GraphQL `orderBy` enum only accepts createdAt / updatedAt — manual
// ordering lives in the `sortOrder` float on each issue and is sorted
// client-side (in FetchAssigned, before returning to the frontend).
// Using `orderBy: updatedAt` here just so the API call is deterministic;
// the final sort is applied after the response is parsed.
const assignedQuery = `
query AssignedIssues {
  viewer {
    assignedIssues(
      first: 250,
      filter: { state: { type: { nin: ["canceled"] } } },
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        url
        priority
        sortOrder
        state { id name type color }
        team {
          id
          key
          states(first: 15) {
            nodes { id name type color position }
          }
        }
      }
    }
  }
}
`

// doGraphQL runs a single POST to Linear's GraphQL endpoint with the given
// query + variables. Kept generic so FetchAssigned and MoveIssue can share
// transport, auth, timeout, and error handling.
func doGraphQL(apiKey, query string, variables map[string]any, into any) error {
	if apiKey == "" {
		return errors.New("linear api key is not set")
	}
	body := map[string]any{"query": query}
	if variables != nil {
		body["variables"] = variables
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("linear: http %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(into)
}

// FetchAssigned returns the viewer's open+recently-completed issues, newest
// first, plus a teamID → []State map so the client can resolve status
// transitions without extra API calls.
func FetchAssigned(apiKey string) (FetchResult, error) {
	var parsed gqlResponse
	if err := doGraphQL(apiKey, assignedQuery, nil, &parsed); err != nil {
		return FetchResult{}, err
	}
	if len(parsed.Errors) > 0 {
		return FetchResult{}, fmt.Errorf("linear: %s", parsed.Errors[0].Message)
	}

	nodes := parsed.Data.Viewer.AssignedIssues.Nodes
	issues := make([]Issue, 0, len(nodes))
	teamStates := make(map[string][]State)
	for _, n := range nodes {
		issues = append(issues, Issue{
			ID:          n.ID,
			Identifier:  n.Identifier,
			Title:       n.Title,
			URL:         n.URL,
			Priority:    n.Priority,
			SortOrder:   n.SortOrder,
			StateID:     n.State.ID,
			StatusName:  n.State.Name,
			StatusType:  n.State.Type,
			StatusColor: n.State.Color,
			TeamID:      n.Team.ID,
			TeamKey:     n.Team.Key,
		})
		if _, ok := teamStates[n.Team.ID]; !ok {
			states := make([]State, 0, len(n.Team.States.Nodes))
			for _, s := range n.Team.States.Nodes {
				states = append(states, State{
					ID:       s.ID,
					Name:     s.Name,
					Type:     s.Type,
					Color:    s.Color,
					Position: s.Position,
				})
			}
			teamStates[n.Team.ID] = states
		}
	}
	// Sort by Linear's manual sortOrder (lower = higher in list) so
	// the Cloovies kanban mirrors whatever order the user has set
	// in Linear's UI. The GraphQL `orderBy` enum can't do this
	// server-side — only createdAt / updatedAt are accepted there
	// — so the manual ordering is applied client-side here.
	sort.SliceStable(issues, func(i, j int) bool {
		return issues[i].SortOrder < issues[j].SortOrder
	})
	return FetchResult{Issues: issues, TeamStates: teamStates}, nil
}

// ViewerInfo is the minimal shape returned by TestKey — used by the
// settings UI to confirm an API key is valid and which Linear account
// it's authenticated as.
type ViewerInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

const viewerQuery = `
query Me {
  viewer { id name email }
}
`

type viewerResponse struct {
	Data struct {
		Viewer ViewerInfo `json:"viewer"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// TestKey pings Linear's `viewer` query so the settings UI can confirm
// an API key is valid and surface the authenticated account.
func TestKey(apiKey string) (ViewerInfo, error) {
	var parsed viewerResponse
	if err := doGraphQL(apiKey, viewerQuery, nil, &parsed); err != nil {
		return ViewerInfo{}, err
	}
	if len(parsed.Errors) > 0 {
		return ViewerInfo{}, fmt.Errorf("linear: %s", parsed.Errors[0].Message)
	}
	if parsed.Data.Viewer.ID == "" {
		return ViewerInfo{}, errors.New("linear: empty viewer response")
	}
	return parsed.Data.Viewer, nil
}

const moveMutation = `
mutation MoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
`

type moveResponse struct {
	Data struct {
		IssueUpdate struct {
			Success bool `json:"success"`
		} `json:"issueUpdate"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// MoveIssue updates the given issue's workflow state. The caller resolves
// the concrete stateID from the team's state list; this is kept dumb on
// purpose so it's easy to test and reuse for non-kanban transitions.
func MoveIssue(apiKey, issueID, stateID string) error {
	if issueID == "" || stateID == "" {
		return errors.New("linear: issueID and stateID required")
	}
	var parsed moveResponse
	vars := map[string]any{"id": issueID, "stateId": stateID}
	if err := doGraphQL(apiKey, moveMutation, vars, &parsed); err != nil {
		return err
	}
	if len(parsed.Errors) > 0 {
		return fmt.Errorf("linear: %s", parsed.Errors[0].Message)
	}
	if !parsed.Data.IssueUpdate.Success {
		return errors.New("linear: issue update did not succeed")
	}
	return nil
}

const priorityMutation = `
mutation SetPriority($id: String!, $priority: Int!) {
  issueUpdate(id: $id, input: { priority: $priority }) {
    success
  }
}
`

// SetIssuePriority updates just the priority field. Linear's scheme:
//   0 none · 1 urgent · 2 high · 3 medium · 4 low
func SetIssuePriority(apiKey, issueID string, priority int) error {
	if issueID == "" {
		return errors.New("linear: issueID required")
	}
	if priority < 0 || priority > 4 {
		return fmt.Errorf("linear: priority %d out of range (0..4)", priority)
	}
	var parsed moveResponse // same shape as move: { issueUpdate { success } }
	vars := map[string]any{"id": issueID, "priority": priority}
	if err := doGraphQL(apiKey, priorityMutation, vars, &parsed); err != nil {
		return err
	}
	if len(parsed.Errors) > 0 {
		return fmt.Errorf("linear: %s", parsed.Errors[0].Message)
	}
	if !parsed.Data.IssueUpdate.Success {
		return errors.New("linear: issue update did not succeed")
	}
	return nil
}
