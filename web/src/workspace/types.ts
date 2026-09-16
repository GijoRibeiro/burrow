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
  headId?: string;
  role?: "head";
  goal?: string;
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
  plans?: TeamPlan[];
  tasks?: AgentTask[];
  version: number;
  projects: Project[];
  terminals: Session[];
  tmuxAvailable: boolean;
}

export interface AgentTask {
  planId?: string;
  planItemId?: string;
  issue?: LinearIssue;
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

export interface TeamItem {
  id: string;
  name: string;
  title: string;
  program: "claude" | "codex";
  instructions: string;
  issue?: LinearIssue;
  taskId?: string;
  error?: string;
}
export interface TeamPlan {
  id: string;
  headId: string;
  title: string;
  summary: string;
  status: "proposed" | "launching" | "active" | "partial" | "canceled";
  items: TeamItem[];
  createdAt: string;
  approvedAt?: string;
}
