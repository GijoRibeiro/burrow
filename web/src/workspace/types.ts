export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string;
  state: { name: string };
}
export interface Worktree {
  parentPath?: string;
  baseCommit?: string;
  issue?: LinearIssue;
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
  taskId?: string;
  program?: "shell" | "claude" | "codex";
  id: string;
  projectId: string;
  path: string;
  name: string;
  createdAt: string;
  status: "running" | "stopped" | "exited";
}
export interface Workspace {
  tasks?: AgentTask[];
  version: number;
  projects: Project[];
  terminals: Session[];
  tmuxAvailable: boolean;
}

export interface AgentTask {
  id: string;
  projectId: string;
  parentId: string;
  agentId: string;
  parentPath: string;
  path: string;
  title: string;
  instructions: string;
  status: "working" | "waiting" | "done" | "canceled";
  summary?: string;
  resultCommit?: string;
  integratedCommit?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentMessage {
  id: string;
  taskId?: string;
  from: string;
  to: string;
  text: string;
  createdAt: string;
  readAt?: string;
}
export interface Coordination {
  tasks: AgentTask[];
  messages: AgentMessage[];
  cli: string;
}
