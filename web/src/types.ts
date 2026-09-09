export interface Task {
  id: string;
  subject: string;
  status: string; // pending | in_progress | completed
  // Set by the scanner when a pending/in_progress todo has been worked
  // past (a higher-id todo is already completed). Rendered dimmed and
  // excluded from the active task list.
  abandoned?: boolean;
}

export interface Agent {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  creatureId: string;
  status: string;
  currentTask: string;
  tasks: Task[];
  contextTokens: number;
  taskElapsedMs: number;
  activeSinceMs: number;
  startedAt: string;
  activeSubs: number;
  totalSubs: number;
  subagents: { id: string; type: string; description: string; active: boolean }[];
  commitsToday: number;
  pushesToday: number;
  mergesToday: number;
  totalCommits: number;
  branch: string;
  worktree: string;
  devUrls?: string[]; // local server URLs seen in the agent's output (dev servers it started)
  awaitingChoice?: boolean;
  picker?: Picker | null;
}

export interface PickerOption {
  number: number;
  label: string;
  description?: string; // indented explanatory text under the title (AskUserQuestion)
  isCheckbox?: boolean; // true = a toggle in a multi-select; false = immediate action
  checked?: boolean; // current checkbox state (multi-select only)
}

export interface Picker {
  question: string;
  options: PickerOption[];
  cursor: number; // 1-indexed; 0 = unknown
  multiSelect?: boolean; // options are checkboxes the user toggles, then submits
  preview?: string; // right-column preview panel (verbatim), mirrored in monospace
}

export interface StateMessage {
  type: 'state';
  agents: Agent[];
}

export interface CommandResponse {
  type: 'command_response';
  text: string;
}

export interface ChatStreamMessage {
  type: 'chat_stream';
  text: string;
  done: boolean;
  cwd?: string;
}

export interface SettingsResponse {
  type: 'settings_response';
  settings: {
    terminalApp: string;
    recentFolders?: string[];
    linearApiKey?: string;
  };
}

export interface BossReplyMessage {
  type: 'boss_reply';
  text: string;
  done: boolean;
}

export interface BossEventMessage {
  type: 'boss_event';
  event: string; // "spawned", "stopped", "messaged", "error"
  detail: string;
}

export interface AgentFinishedMessage {
  type: 'agent_finished';
  name: string;
  cwd: string;
  text: string;
}

export interface DebugLogMessage {
  type: 'debug_log';
  text: string;
}

export interface SpawnAgentResponse {
  type: 'spawn_agent_response';
  success: boolean;
  error?: string;
  path?: string;
}

export interface SpawnWorktreeAgentResponse {
  type: 'spawn_worktree_agent_response';
  success: boolean;
  error?: string;
  path?: string;
  name?: string;
}

export interface RemoveWorktreeResponse {
  type: 'remove_worktree_response';
  success: boolean;
  error?: string;
}

export interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  hasSession: boolean;
}

export interface ListWorktreesResponse {
  type: 'list_worktrees_response';
  success: boolean;
  error?: string;
  sourceCwd: string;
  worktrees: WorktreeEntry[];
}

export interface StopAgentResponse {
  type: 'stop_agent_response';
  success: boolean;
  error?: string;
}

export interface AttachAgentResponse {
  type: 'attach_agent_response';
  success: boolean;
  error?: string;
}

export interface VerboseBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  toolName?: string;
  input?: string;
  output?: string;
}

export interface ChatStreamVerboseMessage {
  type: 'chat_stream_verbose';
  blocks: VerboseBlock[];
  cwd?: string;
}

export type ServerMessage = StateMessage | CommandResponse | ChatStreamMessage | SettingsResponse | BossReplyMessage | BossEventMessage | AgentFinishedMessage | DebugLogMessage | ChatStreamVerboseMessage | SpawnAgentResponse | SpawnWorktreeAgentResponse | RemoveWorktreeResponse | ListWorktreesResponse | StopAgentResponse | AttachAgentResponse;

export interface CreatureDefinition {
  id: string;
  name: string;
  spriteSheet: string;
  color: string;
}
