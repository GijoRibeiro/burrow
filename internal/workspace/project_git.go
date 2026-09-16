package workspace

import "fmt"

// InitializeProjectGit creates repository metadata only. Files, the index, user
// identity, remotes and existing history are never changed by this action.
func (m *Manager) InitializeProjectGit(projectID string) (Project, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := m.project(projectID)
	if err != nil {
		return Project{}, err
	}
	trees, isGit, err := projectCheckouts(p.Path)
	if err != nil {
		return Project{}, err
	}
	if !isGit {
		if _, err = git(p.Path, "init", "-b", "main"); err != nil {
			return Project{}, fmt.Errorf("could not create Git repository: %w", err)
		}
		trees, isGit, err = projectCheckouts(p.Path)
		if err != nil {
			return Project{}, err
		}
	}
	p.Git, p.Worktrees, p.Error = isGit, trees, ""
	for i := range m.state.Projects {
		if m.state.Projects[i].ID == p.ID {
			m.state.Projects[i] = p
		}
	}
	// The filesystem is authoritative. Retrying after a save error is idempotent.
	if err = m.save(); err != nil {
		return Project{}, err
	}
	return p, nil
}
