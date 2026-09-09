import { ServerMessage } from './types';

export type MessageHandler = (msg: ServerMessage) => void;
export type StateHandler = (connected: boolean) => void;

export class Connection {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private stateHandlers: StateHandler[] = [];
  private reconnectTimer: number | null = null;
  private lastNotifiedState = false;

  constructor(private url: string) {}

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.notifyState(true);
    };

    this.ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('[ws] malformed message, skipping:', event.data);
        return;
      }
      this.handlers.forEach((h) => h(msg));
    };

    this.ws.onclose = () => {
      this.notifyState(false);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onStateChange(handler: StateHandler): void {
    this.stateHandlers.push(handler);
    // Fire immediately with the current state so new listeners sync up.
    handler(this.isConnected());
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Returns true on successful send, false if the socket wasn't OPEN.
  // Callers that need to preserve user input on failure (the chat box)
  // MUST check the return value — silent no-ops are how messages get lost.
  private trySend(payload: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendCommand(text: string): boolean {
    return this.trySend({ type: 'command', text });
  }

  sendChat(cwd: string, sessionId: string, pid: number, text: string): boolean {
    return this.trySend({ type: 'chat', cwd, sessionId, pid, text });
  }

  sendChatWithImages(cwd: string, sessionId: string, pid: number, text: string, images: string[]): boolean {
    return this.trySend({ type: 'chat_with_images', cwd, sessionId, pid, text, images });
  }

  // Drive a multi-select picker without the chat send path. `digit` (when set)
  // toggles that option; `submit` (when true) sends Enter to confirm.
  sendPickerKey(pid: number, digit: string, submit: boolean): boolean {
    return this.trySend({ type: 'picker_key', pid, digit, submit });
  }

  sendBossMessage(text: string, images?: string[], thinkMode?: boolean): boolean {
    const msg: Record<string, unknown> = { type: 'boss_message', text };
    if (images && images.length > 0) msg.images = images;
    if (thinkMode) msg.thinkMode = true;
    return this.trySend(msg);
  }

  sendBossCancel(): boolean {
    return this.trySend({ type: 'boss_cancel' });
  }

  sendSettings(action: string, key?: string, value?: string): boolean {
    return this.trySend({ type: 'settings', action, key, value });
  }

  spawnAgent(openInTerminal = false, skipPermissions = false): boolean {
    return this.trySend({ type: 'spawn_agent', openInTerminal, skipPermissions });
  }

  spawnAgentPath(path: string, openInTerminal = false, skipPermissions = false): boolean {
    return this.trySend({ type: 'spawn_agent_path', path, openInTerminal, skipPermissions });
  }

  spawnWorktreeAgent(
    sourceCwd: string,
    name: string,
    openInTerminal = false,
    skipPermissions = false,
  ): boolean {
    return this.trySend({
      type: 'spawn_worktree_agent',
      sourceCwd,
      name,
      openInTerminal,
      skipPermissions,
    });
  }

  removeWorktree(worktreePath: string, force = false): boolean {
    return this.trySend({ type: 'remove_worktree', worktreePath, force });
  }

  listWorktrees(sourceCwd: string): boolean {
    return this.trySend({ type: 'list_worktrees', sourceCwd });
  }

  stopAgent(pid: number): boolean {
    return this.trySend({ type: 'stop_agent', pid });
  }

  interruptAgent(pid: number): boolean {
    return this.trySend({ type: 'interrupt_agent', pid });
  }

  attachAgent(pid: number): boolean {
    return this.trySend({ type: 'attach_agent', pid });
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private notifyState(connected: boolean): void {
    if (this.lastNotifiedState === connected) return;
    this.lastNotifiedState = connected;
    this.stateHandlers.forEach((h) => h(connected));
  }
}
