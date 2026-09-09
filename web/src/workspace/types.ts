export interface Worktree {
  path: string;
  name: string;
  branch: string;
  main: boolean;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  worktrees: Worktree[];
  error?: string;
}
export interface Session {
  program?: "shell" | "claude" | "codex";
  id: string;
  projectId: string;
  path: string;
  name: string;
  createdAt: string;
  status: "running" | "stopped" | "exited";
}
export interface Workspace {
  version: number;
  projects: Project[];
  terminals: Session[];
  tmuxAvailable: boolean;
}
