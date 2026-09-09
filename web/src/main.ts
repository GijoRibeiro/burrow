import { Connection } from './connection';
import { State } from './state';
import { Agent, AttachAgentResponse, Picker, VerboseBlock, WorktreeEntry } from './types';
import { openSettingsModal, Settings, DEFAULT_BG_COLOR, DEFAULT_BUBBLE_USER, DEFAULT_BUBBLE_AGENT, DEFAULT_BUBBLE_BOSS } from './ui/settings';
import { initImageQueue, addImage, addImageFromBase64, clearImages, getImages, hasImages } from './ui/image-queue';
import { renderMarkdown, renderToolUse, summarizeToolCall } from './ui/markdown';
import { agentColor, resetAgentColors } from './ui/colors';
import { appendDebugLog, toggleDebugPanel } from './ui/debug';
import { getLevel, levelColor } from './leveling';
import { formatElapsed, formatTokens, shortenPath } from './utils';
import { loadAllProfiles, getProfile, displayName, saveCreatureAssignment, resolveCreatureIndex, saveAgentName, loadAgentName, addBonusXP, getBonusXP } from './profiles';
import { Creature, CREATURES, imageCache, loadCreatures } from './creatures';
import { initMusic, setMusicEnabled, setMusicStyle, setMusicDither, setMusicLyrics, setMusicSource, getCurrentArtwork, ditherPreview } from './ui/music';
import { applyChatFont, DEFAULT_CHAT_FONT_ID } from './ui/chat-fonts';
import { initLinear, setLinearEnabled, refreshLinear, clearLinearWorkingForCwd } from './ui/linear';
import { initLayout } from './ui/layout';
import { initSectionScales } from './ui/section-scale';
import { initFileDrop } from './ui/file-drop';
import { initLanes, addLane, removeLane, hasLane, laneHistoryEl, laneTaskPanelEl, eachLane, markLaneDead, markLaneWorking, focusLaneInput, hasAnyAgentLane, laneOrder, isLaneCollapsed, setLanePicker } from './ui/lanes';
import { attachLaneDragSource, setupLaneDropTarget } from './ui/lane-drag';
import { openWorktreeSpawn, closeWorktreeSpawn, SpawnHandle } from './ui/worktree-spawn';
import { initPreflight } from './ui/preflight';

const conn = new Connection('ws://localhost:3333/ws');

// Open worktree-spawn popovers waiting for their `list_worktrees`
// response. Keyed by the source repo cwd (the same value sent in the
// request) so the response handler can route the entries to the right
// popover. The popover itself guards `setExisting` against being
// called after dismissal, so a leftover entry here is harmless.
const pendingWorktreeSpawnHandles = new Map<string, SpawnHandle>();

// Repo cwd of a worktree deletion initiated from the spawn popover's
// existing-worktrees list. `remove_worktree_response` doesn't echo the
// path, so this is how the response handler knows the delete came from
// the popover (refresh its list, show errors inline) rather than from
// a frame's × button (which keeps its window.alert fallback).
let pendingPopoverDeleteRepo: string | null = null;
const state = new State();

let selectedCwd: string | null = null;
let selectedSessionId: string | null = null;
let selectedPid: number | null = null;
let currentSettings: Settings = { terminalApp: 'terminal' };
let soloMode = localStorage.getItem('soloMode') === '1';
let bossThinkMode = localStorage.getItem('bossThinkMode') === '1';
let verboseMode = localStorage.getItem('verboseMode') === '1';
let avatarsHidden = localStorage.getItem('avatarsHidden') === '1';
let bgColor = localStorage.getItem('bgColor') || DEFAULT_BG_COLOR;
function applyBgColor() {
  document.documentElement.style.setProperty('--bg', bgColor);
}
applyBgColor();
let musicEnabled = localStorage.getItem('musicEnabled') === '1';
let musicStyle = localStorage.getItem('musicStyle') || 'framed';
let musicDither = localStorage.getItem('musicDither') || '6';
let musicLyrics = localStorage.getItem('musicLyrics') !== '0';
let musicSource = localStorage.getItem('musicSource') || 'auto';
let linearEnabled = localStorage.getItem('linearEnabled') === '1';
let lanesVertical = localStorage.getItem('lanesVertical') === '1';
function applyLanesVertical() {
  document.body.classList.toggle('lanes-vertical', lanesVertical);
}
applyLanesVertical();
let chatBubbles = localStorage.getItem('chatBubbles') === '1';
let bubbleUserColor  = localStorage.getItem('bubbleUserColor')  || DEFAULT_BUBBLE_USER;
let bubbleAgentColor = localStorage.getItem('bubbleAgentColor') || DEFAULT_BUBBLE_AGENT;
let bubbleBossColor  = localStorage.getItem('bubbleBossColor')  || DEFAULT_BUBBLE_BOSS;
let agentsMinimal = localStorage.getItem('agentsMinimal') === '1';
let notifyOnFinish = localStorage.getItem('notifyOnFinish') === '1';
let chatFont = localStorage.getItem('chatFont') || DEFAULT_CHAT_FONT_ID;
// Apply on boot so the user's saved font is in place before #chat-response
// renders any messages — avoids a one-frame flash of the default stack.
applyChatFont(chatFont);

// Throttle map: agentCwd → last-fired-timestamp. Prevents a flapping
// idle ↔ active agent (or duplicated agent_finished broadcasts on
// websocket reconnect) from firing notification-storm. 8-second
// quiet window per agent — if the same agent finishes twice within
// that window, only the first notification fires.
const _notifyLastFired = new Map<string, number>();
const NOTIFY_THROTTLE_MS = 8000;

function maybeNotifyAgentFinished(name: string, cwd: string, text: string): void {
  if (!notifyOnFinish) return;
  if (typeof Notification === 'undefined') return;
  const now = Date.now();
  const prev = _notifyLastFired.get(cwd) ?? 0;
  if (now - prev < NOTIFY_THROTTLE_MS) return;
  _notifyLastFired.set(cwd, now);

  const fire = () => {
    try {
      // Trim to a sentence-or-two preview so the notification body
      // stays scannable. macOS truncates at ~150 chars anyway.
      const body = text.length > 140 ? text.slice(0, 137) + '…' : text;
      new Notification(`${name} finished`, {
        body: body || 'Agent is ready for the next instruction.',
        tag: `cloovies-agent-${cwd}`, // dedupes per-agent in the OS notification tray
        silent: false,
      });
    } catch { /* swallow — notification API can throw if revoked mid-session */ }
  };

  if (Notification.permission === 'granted') {
    fire();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') fire();
    });
  }
}
function applyChatBubbles() {
  document.body.classList.toggle('chat-bubbles', chatBubbles);
}
function applyBubbleColors() {
  const root = document.documentElement.style;
  root.setProperty('--bubble-user-bg',  bubbleUserColor);
  root.setProperty('--bubble-agent-bg', bubbleAgentColor);
  root.setProperty('--bubble-boss-bg',  bubbleBossColor);
}
function applyAgentsMinimal() {
  document.body.classList.toggle('agents-minimal', agentsMinimal);
}
applyChatBubbles();
applyBubbleColors();
applyAgentsMinimal();
let utkuAutoMode = localStorage.getItem('utkuAutoMode') === '1';
const UTKU_AUTO_CHANCE = 0.3;
let bossCreatureId = localStorage.getItem('bossCreatureId') || '';

function getBossCreature(): Creature | null {
  if (CREATURES.length === 0) return null;
  if (bossCreatureId) {
    const found = CREATURES.find((c) => c.id === bossCreatureId);
    if (found) return found;
  }
  return CREATURES[0];
}

const MAX_INPUT_HISTORY = 200;
const inputHistory: string[] = [];
let inputHistoryIndex = -1;
let inputHistorySaved = '';

interface ChatHistoryEntry {
  role: 'user' | 'boss' | 'system';
  text: string;
  timestamp: number;
  streaming?: boolean;
  agentCwd?: string | null;
  html?: string;
  images?: string[];
  target?: string;
  verboseBlocks?: VerboseBlock[];
}

// Cap chat history to prevent unbounded growth in long sessions.
const MAX_CHAT_HISTORY = 500;
const CHAT_STORAGE_KEY = 'cloovies_chat_history';
const CHAT_PERSIST_COUNT = 200;
const chatHistory: ChatHistoryEntry[] = [];

// Restore chat history from localStorage on load. Runs once at module init so the
// history is available before the WebSocket starts pushing live messages.
(function restoreChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const e of arr) chatHistory.push({ ...e, streaming: false });
    }
  } catch { /* ignore parse/quota errors */ }
})();

// Paint restored history once the DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => renderChatHistory(), { once: true });
} else {
  queueMicrotask(() => renderChatHistory());
}

let chatPersistTimer: number | null = null;
// Per-lane recency cap. Each lane (each destination cwd, plus null
// for lane 0 / boss) gets up to this many messages saved
// independently. Without this the global 200-cap let a chatty boss
// conversation push out an agent lane's history even though the
// agent lane wasn't chatty — the user complained about chats
// "sharing" history. Bucketing per destination preserves each
// lane's most-recent N regardless of activity elsewhere.
const PER_LANE_PERSIST = 80;
function persistChatHistory() {
  if (chatPersistTimer !== null) return;
  chatPersistTimer = window.setTimeout(() => {
    chatPersistTimer = null;
    try {
      const buckets = new Map<string | null, ChatHistoryEntry[]>();
      for (const e of chatHistory) {
        const dest = entryDestCwd(e);
        const arr = buckets.get(dest);
        if (arr) arr.push(e);
        else buckets.set(dest, [e]);
      }
      // Take last N per bucket, then merge and re-sort by timestamp
      // so the on-load array is in chronological order (the
      // partition / render path is order-independent, but keeping
      // it sorted makes inspection in DevTools sane).
      const merged: ChatHistoryEntry[] = [];
      for (const arr of buckets.values()) {
        merged.push(...arr.slice(-PER_LANE_PERSIST));
      }
      merged.sort((a, b) => a.timestamp - b.timestamp);
      const slim = merged.map(e => ({
        role: e.role,
        text: e.text,
        timestamp: e.timestamp,
        agentCwd: e.agentCwd,
        target: e.target,
      }));
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(slim));
    } catch { /* quota exceeded or disabled */ }
  }, 500);
}

function pushChat(entry: ChatHistoryEntry) {
  chatHistory.push(entry);
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
  }
  persistChatHistory();
}

// --- Chat undo / redo ----------------------------------------------------
//
// Bounded snapshot stack for destructive chatHistory mutations — primarily
// `/clear`, which is the most common "I didn't mean to do that" action.
// Sends are NOT snapshotted: the agent has already received the message
// over tmux and there's no way to unsend it; rolling back the local
// view alone would put the UI out of sync with the agent's state.
//
// Cmd+Z (or Ctrl+Z) restores the previous snapshot. Cmd+Shift+Z redoes.
// New snapshots clear the redo stack — standard editor behaviour.
const MAX_UNDO = 20;
const undoStack: ChatHistoryEntry[][] = [];
const redoStack: ChatHistoryEntry[][] = [];

function snapshotChatForUndo(): void {
  // Deep-enough copy: each entry is shallow-cloned so the snapshot
  // doesn't mutate when the live array gains new entries (the
  // entries themselves are mostly immutable strings/numbers; the
  // `streaming` flag flips, but a snapshot capturing the post-edit
  // state is what we want to restore anyway).
  undoStack.push(chatHistory.map((e) => ({ ...e })));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

function applyChatSnapshot(snap: ChatHistoryEntry[]): void {
  chatHistory.length = 0;
  for (const e of snap) chatHistory.push(e);
  persistChatHistory();
  renderChatHistory();
}

function chatUndo(): boolean {
  if (undoStack.length === 0) return false;
  redoStack.push(chatHistory.map((e) => ({ ...e })));
  const prev = undoStack.pop()!;
  applyChatSnapshot(prev);
  return true;
}

function chatRedo(): boolean {
  if (redoStack.length === 0) return false;
  undoStack.push(chatHistory.map((e) => ({ ...e })));
  const next = redoStack.pop()!;
  applyChatSnapshot(next);
  return true;
}

function lastEntry(): ChatHistoryEntry | null {
  return chatHistory.length > 0 ? chatHistory[chatHistory.length - 1] : null;
}

function lastStreamingSystem(cwd: string | null | undefined): ChatHistoryEntry | null {
  // Walk back through recent history (not just lastEntry) so a user
  // message landing in *another* lane mid-turn doesn't fork an agent's
  // single streaming response into two history entries. But if the
  // user message targets THIS agent (same cwd), that's a turn boundary
  // — the next chat_stream is the response to THAT prompt and must
  // become a fresh entry below it, not get welded onto the previous
  // turn's bubble (which is the bug that made user prompts look stuck
  // while the response silently grew the previous response above them).
  const start = Math.max(0, chatHistory.length - 6);
  for (let i = chatHistory.length - 1; i >= start; i--) {
    const e = chatHistory[i];
    if (e.role === 'user') {
      const dest = entryDestCwd(e);
      if (dest === cwd) return null; // turn boundary — start a new entry
      continue; // cross-lane user noise — keep looking for our stream
    }
    if (e.role === 'system' && e.streaming && e.agentCwd === cwd) return e;
    // First non-matching system entry stops the search — we don't
    // want to merge into something that's already been finalized.
    if (e.role === 'system') return null;
    if (e.role === 'boss') return null;
  }
  return null;
}

function pushSystem(cwd: string | null, text: string, extras?: Partial<ChatHistoryEntry>) {
  pushChat({ role: 'system', text, timestamp: Date.now(), agentCwd: cwd, ...extras });
}

// --- Boss banner state ---
let lastBossAction = '';
let bossThinking = false;

function updateBossStopButton() {
  const btn = document.getElementById('boss-stop');
  if (btn) btn.style.display = bossThinking ? '' : 'none';
}

function cancelBoss() {
  if (!bossThinking) return;
  conn.sendBossCancel();
  bossThinking = false;
  updateBossStopButton();
  const last = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1] : null;
  if (last && last.streaming) {
    last.streaming = false;
    if (!last.text) last.text = '(cancelled)';
  }
  renderChatHistory();
}

function appendChatMessage(role: 'user' | 'boss' | 'system', text: string, images?: string[], target?: string) {
  pushChat({ role, text, timestamp: Date.now(), images, target });
  renderChatHistory();
}

// --- Chat rendering ---

let chatRenderQueued = false;
function renderChatHistory() {
  if (chatRenderQueued) return;
  chatRenderQueued = true;
  requestAnimationFrame(() => {
    chatRenderQueued = false;
    renderChatHistoryNow();
  });
}

// Resolve a chat entry's destination cwd for lane routing. System
// messages have agentCwd directly. User messages carry a target name
// (display name); we map back to cwd via the agent grid state. Boss
// and unknown roles fall through to lane 0 (null).
function entryDestCwd(entry: ChatHistoryEntry): string | null {
  if (entry.role === 'system') return entry.agentCwd ?? null;
  if (entry.role === 'user') {
    if (entry.agentCwd) return entry.agentCwd;
    if (entry.target && entry.target !== 'boss') {
      const agents = state.getAgents();
      const match = agents.find((a) => displayName(a.cwd) === entry.target);
      return match?.cwd ?? null;
    }
  }
  return null;
}

function renderChatHistoryNow() {
  // Clear and re-render every lane in one pass. Each chat entry is
  // routed to the lane whose cwd matches its destination (or lane 0
  // when no dedicated lane exists). Per-lane recency cap is applied
  // after partition so each lane stays at the latest 50 messages
  // independently.
  const laneBuckets = new Map<string | null, ChatHistoryEntry[]>();
  // Seed buckets so every visible lane has an entry (even empty).
  laneBuckets.set(null, []);
  eachLane((lane) => { if (lane.cwd) laneBuckets.set(lane.cwd, []); });

  for (const entry of chatHistory) {
    const dest = entryDestCwd(entry);
    const bucketKey = dest && hasLane(dest) ? dest : null;
    const bucket = laneBuckets.get(bucketKey);
    if (bucket) bucket.push(entry);
  }

  // SoloMode applies only to lane 0 (where unscoped messages land).
  // Agent lanes are inherently solo'd to their cwd.
  if (soloMode && selectedCwd) {
    const key = selectedCwd;
    const lane0 = laneBuckets.get(null) ?? [];
    laneBuckets.set(null, lane0.filter(e =>
      (e.role === 'system' && e.agentCwd === key) ||
      (e.role === 'system' && !e.agentCwd) ||
      (e.role === 'user' && e.target && e.target === displayName(key))
    ));
  }

  // Render each bucket into its lane's history element. Pass the
  // bucket's cwd so renderEntries knows whether it's drawing into
  // an agent lane (and can short-circuit redundant "you to X >"
  // labels — every message in an agent lane targets the same X).
  for (const [cwd, entries] of laneBuckets) {
    const el = laneHistoryEl(cwd);
    if (!el) continue;
    el.innerHTML = '';
    renderEntries(el, entries.slice(-50), cwd);
  }
}

// Re-show the agent avatar/name badge if the same agent's previous
// rendered message landed more than this many ms ago. Acts as a
// "still here" bookmark when an agent thinks for a long time and
// finally posts again — without it, the avatar only appears for
// the first message in a run, which is easy to miss after waiting.
const AGENT_BADGE_REPEAT_MS = 30_000;

function renderEntries(el: HTMLElement, recent: ChatHistoryEntry[], laneCwd: string | null = null): void {
  // Inside an agent lane every user message targets that lane's
  // agent, so "you to <name> >" is redundant — collapse it to a
  // plain "you >" prompt. Lane 0 still gets the full prefix because
  // the user might be addressing different agents from there.
  const inAgentLane = !!laneCwd;
  let prevAgentCwd: string | null = null;
  let prevAgentTimestamp = 0;
  for (const entry of recent) {
    // Skip system entries with nothing to show (no text, and either verbose is off
    // or there are no verbose blocks). Prevents stacked empty agent badges when
    // tool-only log lines arrive without accompanying assistant text.
    if (entry.role === 'system' && !entry.text) {
      const hasVerbose = verboseMode && entry.verboseBlocks && entry.verboseBlocks.length > 0;
      const hasImages = entry.images && entry.images.length > 0;
      if (!hasVerbose && !hasImages) continue;
    }
    const msgEl = document.createElement('div');
    // `chat-agent` is added for system-role entries that originated from
    // an agent (i.e. have an agentCwd) so bubble mode can left-align
    // them like the boss while real system logs stay centered.
    const isAgentReply = entry.role === 'system' && entry.agentCwd;
    msgEl.className = `chat-msg chat-${entry.role}` + (isAgentReply ? ' chat-agent' : '');
    if (isAgentReply) {
      msgEl.style.color = agentColor(entry.agentCwd!);
    }
    if (entry.role === 'boss' && entry.streaming && entry.text === '') {
      msgEl.innerHTML = '<span class="boss-thinking"></span>';
    } else if (entry.role === 'system' && entry.agentCwd) {
      const rendered = renderMarkdown(entry.text).replace(/^(<br\s*\/?>)+/i, '');
      const sameAgent = entry.agentCwd === prevAgentCwd;
      const gap = entry.timestamp - prevAgentTimestamp;
      // Show the badge when a new agent starts speaking OR when the
      // same agent re-emerges after a long pause — handy as a
      // visual bookmark for "the agent finally got back to me."
      const showBadge = !sameAgent || gap >= AGENT_BADGE_REPEAT_MS;
      if (showBadge) {
        msgEl.innerHTML = buildAgentBadgeHtml(entry.agentCwd, '') + '<br>' + rendered;
      } else {
        msgEl.innerHTML = rendered;
      }
    } else if (entry.html) {
      msgEl.innerHTML = entry.html;
    } else if (entry.role === 'user' && entry.target) {
      let prefix: string;
      if (inAgentLane) {
        // The lane itself identifies the target — drop the prefix
        // entirely so the user message reads as plain text. Lane-zero
        // (boss / multi-agent) still gets the per-message badge below.
        prefix = '';
      } else if (entry.target === 'boss') {
        // Boss messages get a cream tint so the prefix still reads
        // distinctly from the body text.
        prefix = `<span class="chat-user-target-badge" style="--target-color:#eae5ce">`
          + `<span class="chat-user-target-dot"></span>`
          + `<strong>boss</strong>`
          + `</span><span class="chat-user-target"> &gt; </span>`;
      } else {
        // Lane-zero scrollback: promote the dim "you to X >" text to
        // a tinted avatar-dot + name badge so the per-message agent
        // target reads at a glance. Resolve the cwd from the
        // display-name target so the tint matches the agent's
        // palette color (and the lane-tab / grid-frame border).
        const dest = entryDestCwd(entry);
        const color = dest ? agentColor(dest) : '#eae5ce';
        prefix = `<span class="chat-user-target-badge" style="--target-color:${color}">`
          + `<span class="chat-user-target-dot"></span>`
          + `<strong>${entry.target}</strong>`
          + `</span><span class="chat-user-target"> &gt; </span>`;
      }
      msgEl.innerHTML = prefix + renderMarkdown(entry.text);
    } else {
      msgEl.innerHTML = renderMarkdown(entry.text);
    }

    if (entry.images && entry.images.length > 0) {
      const thumbRow = document.createElement('div');
      thumbRow.className = 'chat-image-row';
      for (const dataUrl of entry.images) {
        const img = document.createElement('img');
        img.src = dataUrl;
        img.className = 'chat-image-thumb';
        img.addEventListener('click', () => showImageOverlay(dataUrl));
        thumbRow.appendChild(img);
      }
      msgEl.appendChild(thumbRow);
    }

    if (verboseMode && entry.verboseBlocks && entry.verboseBlocks.length > 0) {
      const verboseEl = document.createElement('div');
      verboseEl.className = 'verbose-output';
      for (const block of entry.verboseBlocks) {
        if (block.type === 'text') {
          const p = document.createElement('div');
          p.innerHTML = renderMarkdown(block.text || '');
          verboseEl.appendChild(p);
        } else if (block.type === 'tool_use') {
          const toolEl = document.createElement('div');
          toolEl.className = 'verbose-tool';
          toolEl.innerHTML = renderToolUse(block.toolName || '', block.input || '');
          verboseEl.appendChild(toolEl);
        } else if (block.type === 'tool_result') {
          const resultEl = document.createElement('pre');
          resultEl.className = 'verbose-result';
          resultEl.textContent = (block.output || '').slice(0, 2000);
          verboseEl.appendChild(resultEl);
        } else if (block.type === 'thinking') {
          const thinkEl = document.createElement('details');
          thinkEl.className = 'verbose-thinking';
          thinkEl.innerHTML = '<summary>thinking...</summary><pre>' +
            (block.text || '').replace(/</g, '&lt;') + '</pre>';
          verboseEl.appendChild(thinkEl);
        }
      }
      msgEl.appendChild(verboseEl);
    }

    el.appendChild(msgEl);
    if (entry.role === 'system' && entry.agentCwd) {
      prevAgentCwd = entry.agentCwd;
      prevAgentTimestamp = entry.timestamp;
    } else {
      prevAgentCwd = null;
      prevAgentTimestamp = 0;
    }
  }

  el.scrollTop = el.scrollHeight;
}

// --- Settings bootstrap ---

fetch('http://localhost:3333/api/settings')
  .then(r => r.json())
  .then((s: Settings & { recentFolders?: string[] }) => {
    currentSettings = s;
    if (s.recentFolders) recentFolders = s.recentFolders;
  })
  .catch(() => {});

// --- WebSocket handlers ---

conn.onStateChange((connected) => {
  const row = document.getElementById('settings-conn-row');
  if (!row) return;
  row.classList.toggle('connected', connected);
  row.classList.toggle('disconnected', !connected);
  const label = row.querySelector('.settings-conn-state');
  if (label) label.textContent = connected ? 'connected' : 'reconnecting…';
  if (connected) conn.sendSettings('get');
});

let recentFolders: string[] = [];

// Queue of messages waiting for a to-be-spawned agent. When the user
// triggers "spawn new agent for this ticket" from the Linear panel, we
// push a message here. The next successful spawn_agent_response binds
// the message to its resolved cwd in `pendingAgentMessages`. Then on
// state broadcasts, we fire the chat to whichever agent appears with a
// matching cwd.
//
// FIFO because multiple spawns can be queued in sequence, and the
// server processes them one at a time via the native folder picker.
const queuedSpawnMessages: string[] = [];
const pendingAgentMessages = new Map<string, string>(); // cwd → message
const messagedAgents = new Set<string>(); // sessionIDs we've already messaged

conn.onMessage((msg) => {
  switch (msg.type) {
    case 'state': {
      state.update(msg.agents);
      updateBossBanner(msg.agents);
      // Any pending Linear hand-off waiting for its spawned agent to
      // appear? Match on cwd. We wait until the agent has a sessionId
      // and pid (scanner has fully picked it up) before sending.
      if (pendingAgentMessages.size > 0) {
        for (const agent of msg.agents) {
          if (!agent.sessionId || !agent.pid) continue;
          if (messagedAgents.has(agent.sessionId)) continue;
          const queued = pendingAgentMessages.get(agent.cwd);
          if (!queued) continue;
          if (conn.sendChat(agent.cwd, agent.sessionId, agent.pid, queued)) {
            messagedAgents.add(agent.sessionId);
            pendingAgentMessages.delete(agent.cwd);
          }
        }
      }
      return;
    }
    case 'command_response': {
      appendChatMessage('system', msg.text);
      return;
    }
    case 'chat_stream': {
      const cwd = msg.cwd || selectedCwd;
      if (!msg.done) {
        const existing = lastStreamingSystem(cwd);
        if (existing) existing.text += '\n\n' + msg.text;
        else pushSystem(cwd, msg.text, { streaming: true });
      } else {
        // Finalise the streaming entry for THIS cwd, not just the
        // very last entry — a user echo may have been pushed after
        // the streaming entry started, in which case `lastEntry()`
        // would point at the user message and never clear the
        // stream's `streaming` flag (which then welds the next
        // turn's response back onto the previous bubble).
        const existing = lastStreamingSystem(cwd);
        if (existing) existing.streaming = false;
      }
      renderChatHistory();
      return;
    }
    case 'chat_stream_verbose': {
      const cwd = msg.cwd || selectedCwd;
      // Drop 'text' blocks — the same text arrives via chat_stream and entry.text,
      // so rendering them here too would duplicate every assistant message.
      const blocks = msg.blocks.filter(b => b.type !== 'text');
      if (blocks.length === 0) return;
      const existing = lastStreamingSystem(cwd);
      if (existing) existing.verboseBlocks = (existing.verboseBlocks || []).concat(blocks);
      else pushSystem(cwd, '', { streaming: true, verboseBlocks: blocks });
      renderChatHistory();
      // Refresh the active-agents bar so the live tool label
      // (Read foo.tsx, Bash npm test, …) updates as new tool_use /
      // tool_result blocks stream in.
      updateActiveAgentsBar();
      return;
    }
    case 'settings_response': {
      currentSettings = msg.settings;
      if (msg.settings.recentFolders) recentFolders = msg.settings.recentFolders;
      return;
    }
    case 'agent_finished': {
      const text = msg.text || '';
      const cwd = msg.cwd || null;
      // Walk back through chatHistory to find the most recent system
      // entry that belongs to THIS agent (cwd match), regardless of
      // what's strictly last. Without this, when you type to a
      // different lane mid-turn the user echo becomes the last entry,
      // the dedup misses the agent's streaming entry, and we push a
      // duplicate. Limit the look-back to the recent slice so we
      // don't accidentally collapse an old, unrelated entry.
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      let recentSystem: ChatHistoryEntry | null = null;
      const lookbackStart = Math.max(0, chatHistory.length - 10);
      for (let i = chatHistory.length - 1; i >= lookbackStart; i--) {
        const e = chatHistory[i];
        if (e.role === 'system' && e.agentCwd === cwd) { recentSystem = e; break; }
      }
      // System notification — let the user step away from the
      // dashboard and still know when their agent is ready. Throttled
      // (see `maybeNotifyAgentFinished`) so a flapping idle ↔ active
      // transition doesn't spam the user. Opt-in via setting. The
      // server omits text the tail already streamed, so fall back to
      // the lane's rendered entry for the notification preview.
      if (cwd && msg.name) maybeNotifyAgentFinished(msg.name, cwd, text || recentSystem?.text || '');
      // Clear any Linear "working" shimmers tied to this agent's cwd.
      // cwd survives reloads, so even if bitwise restarted between the
      // send and the agent's reply, we still clean up correctly.
      if (cwd) clearLinearWorkingForCwd(cwd);
      const alreadyRendered = !!(recentSystem && recentSystem.text && text && norm(recentSystem.text).includes(norm(text)));
      if (recentSystem && (recentSystem.streaming || alreadyRendered)) {
        recentSystem.streaming = false;
      } else if (text) {
        pushSystem(cwd, text);
      }
      renderChatHistory();
      return;
    }
    case 'boss_reply': {
      if (!msg.done) {
        bossThinking = true;
        const last = lastEntry();
        if (last && last.role === 'boss' && last.streaming) last.text += msg.text;
        else pushChat({ role: 'boss', text: msg.text, timestamp: Date.now(), streaming: true });
      } else {
        bossThinking = false;
        updateBossStopButton();
        const last = lastEntry();
        if (last && last.streaming) last.streaming = false;
      }
      renderChatHistory();
      return;
    }
    case 'boss_event': {
      lastBossAction = msg.detail;
      updateBossRight();
      if (msg.event === 'messaged' || msg.event === 'sending') {
        const html = buildAgentEventHtml(msg.detail, msg.event);
        pushChat({ role: 'system', text: msg.detail, timestamp: Date.now(), html });
      } else {
        pushChat({ role: 'system', text: `[${msg.event}] ${msg.detail}`, timestamp: Date.now() });
      }
      renderChatHistory();
      return;
    }
    case 'debug_log': {
      appendDebugLog(msg.text);
      return;
    }
    case 'attach_agent_response': {
      const resp = msg as AttachAgentResponse;
      if (!resp.success) appendChatMessage('system', resp.error || 'failed to attach terminal');
      return;
    }
    case 'spawn_agent_response': {
      const btn = document.getElementById('new-agent-btn');
      if (btn) btn.classList.remove('spawning');
      closeDropdown();
      conn.sendSettings('get');
      // Bind any queued message from "spawn new agent for this ticket"
      // to the resolved cwd so the state handler can send once the
      // agent is picked up by the scanner.
      const resp = msg as { success: boolean; path?: string };
      if (resp.success && resp.path && queuedSpawnMessages.length > 0) {
        const queued = queuedSpawnMessages.shift()!;
        pendingAgentMessages.set(resp.path, queued);
      } else if (!resp.success && queuedSpawnMessages.length > 0) {
        // Drop the message so we don't fire it for a later unrelated spawn.
        queuedSpawnMessages.shift();
      }
      return;
    }
    case 'spawn_worktree_agent_response': {
      const resp = msg as { success: boolean; error?: string };
      if (resp.success) {
        closeWorktreeSpawn();
      } else {
        // Surface the error in the open popover. The popover module
        // doesn't expose its handle externally, so reach into the DOM
        // directly — there's only ever one open popover at a time.
        const err = document.querySelector('.worktree-spawn-error') as HTMLElement | null;
        if (err) err.textContent = resp.error || 'spawn failed';
        const goBtn = document.querySelector('.worktree-spawn-go') as HTMLButtonElement | null;
        if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'spawn'; }
        const nameEl = document.querySelector('.worktree-spawn-name') as HTMLInputElement | null;
        if (nameEl) nameEl.disabled = false;
      }
      return;
    }
    case 'remove_worktree_response': {
      const resp = msg as { success: boolean; error?: string };
      if (pendingPopoverDeleteRepo) {
        // Delete initiated from the spawn popover's existing list.
        // Refresh the list either way — on success the row disappears,
        // on failure the re-render restores the row's delete button
        // (which the popover disabled while the request was in
        // flight). Errors go to the popover's inline error slot; the
        // DOM query mirrors `spawn_worktree_agent_response` (only one
        // popover exists at a time) and is a no-op if it was closed.
        const repo = pendingPopoverDeleteRepo;
        pendingPopoverDeleteRepo = null;
        if (!resp.success) {
          const err = document.querySelector('.worktree-spawn-error') as HTMLElement | null;
          if (err) err.textContent = resp.error || 'delete failed';
        }
        conn.listWorktrees(repo);
      } else if (!resp.success) {
        window.alert(`Remove failed: ${resp.error || 'unknown error'}`);
      }
      return;
    }
    case 'list_worktrees_response': {
      const resp = msg as { sourceCwd: string; success: boolean; worktrees?: WorktreeEntry[]; error?: string };
      const hdl = pendingWorktreeSpawnHandles.get(resp.sourceCwd);
      if (hdl) {
        pendingWorktreeSpawnHandles.delete(resp.sourceCwd);
        if (resp.success) {
          hdl.setExisting((resp.worktrees ?? []).map((w) => ({ name: w.name, branch: w.branch, hasSession: w.hasSession })));
        } else {
          hdl.setExisting([]);
        }
      }
      return;
    }
  }
});

// Floating fallback picker — used when an agent has a Claude Code
// picker pending but no lane could be opened (lane cap reached). The
// agent is BLOCKED waiting for the user's answer, so we always need
// to surface the prompt somewhere; the inline-in-lane rendering is
// the preferred UX, the overlay is the safety net. Only one fallback
// shows at a time; if multiple agents have pending pickers and no
// lanes, the first one wins until answered.
let activeFallbackPicker: { sessionId: string; el: HTMLElement } | null = null;

// Monospace preview block for the floating overlay, labelled with the option
// it belongs to (mirrors buildPickerPreview in lanes.ts).
function buildFallbackPreview(preview: string, forLabel?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lane-picker-preview-wrap';
  const cap = document.createElement('div');
  cap.className = 'lane-picker-preview-cap';
  cap.textContent = forLabel ? `↳ preview: ${forLabel}` : 'preview';
  const pre = document.createElement('pre');
  pre.className = 'lane-picker-preview';
  pre.textContent = preview;
  wrap.appendChild(cap);
  wrap.appendChild(pre);
  return wrap;
}

function showFallbackPicker(agent: Agent, picker: Picker, onPick: (num: number) => void, onSubmit?: () => void): void {
  if (activeFallbackPicker?.sessionId === agent.sessionId) return; // already up
  closeFallbackPicker();

  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay fallback-picker-overlay';

  const modal = document.createElement('div');
  modal.className = 'picker-modal fallback-picker-modal';

  const title = document.createElement('h2');
  title.className = 'picker-title';
  title.textContent = `picker — ${agent.name || displayName(agent.cwd)}`;
  modal.appendChild(title);

  const cwdEl = document.createElement('div');
  cwdEl.className = 'fallback-picker-cwd';
  cwdEl.textContent = shortenPath(agent.cwd);
  modal.appendChild(cwdEl);

  if (picker.question) {
    const q = document.createElement('div');
    q.className = 'fallback-picker-question';
    q.textContent = picker.question;
    modal.appendChild(q);
  }

  const optsEl = document.createElement('div');
  optsEl.className = 'fallback-picker-options';
  let previewPlaced = false;
  for (const opt of picker.options) {
    const isToggle = !!picker.multiSelect && !!opt.isCheckbox;
    const btn = document.createElement('button');
    btn.className = 'fallback-picker-option';
    if (isToggle) btn.classList.add('is-checkbox');
    if (isToggle && opt.checked) btn.classList.add('is-checked');
    const isCursor = !!picker.preview && picker.cursor === opt.number;
    if (isCursor) btn.classList.add('is-cursor');

    const head = isToggle ? (opt.checked ? '☑' : '☐') : `${opt.number}.`;
    btn.textContent = `${head} ${opt.label}`;
    if (opt.description) {
      const desc = document.createElement('span');
      desc.className = 'fallback-picker-desc';
      desc.textContent = opt.description;
      btn.appendChild(desc);
    }

    btn.addEventListener('click', () => {
      if (isToggle) {
        // Toggle in place; keep the overlay open until Submit.
        const checkedNow = !btn.classList.contains('is-checked');
        btn.classList.toggle('is-checked', checkedNow);
        onPick(opt.number);
        return;
      }
      onPick(opt.number);
      closeFallbackPicker();
    });
    optsEl.appendChild(btn);
    // Nest the preview under the highlighted option it belongs to.
    if (isCursor && picker.preview) {
      optsEl.appendChild(buildFallbackPreview(picker.preview, opt.label));
      previewPlaced = true;
    }
  }
  modal.appendChild(optsEl);

  // Cursor unknown — show the preview once, unlabelled, rather than dropping it.
  if (picker.preview && !previewPlaced) {
    modal.appendChild(buildFallbackPreview(picker.preview));
  }

  if (picker.multiSelect && onSubmit) {
    const submit = document.createElement('button');
    submit.className = 'fallback-picker-submit';
    submit.type = 'button';
    submit.textContent = 'Submit';
    submit.addEventListener('click', () => {
      onSubmit();
      closeFallbackPicker();
    });
    modal.appendChild(submit);
  }

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    // Click on the dim backdrop dismisses; the picker re-appears on
    // the next scan tick if the agent's prompt is still active.
    if (e.target === overlay) closeFallbackPicker();
  });
  document.body.appendChild(overlay);
  activeFallbackPicker = { sessionId: agent.sessionId, el: overlay };
}

function closeFallbackPicker(): void {
  if (activeFallbackPicker?.el.parentElement) {
    activeFallbackPicker.el.remove();
  }
  activeFallbackPicker = null;
}

state.onUpdate((agents) => {
  renderAgentGrid(agents);
  updateActiveAgentsBar();
  updateTaskPanel();
  renderChatLinkBar();
  // Pickers: auto-open the lane for any agent whose terminal is
  // currently showing a Claude Code picker, then render the
  // question + clickable options inline above the lane input.
  // Clicking an option sends the digit + Enter to the agent's
  // tmux pane (same path as a typed message), which the picker
  // accepts as the answer. When the picker disappears from the
  // pane on the next scan, the panel hides itself.
  for (const a of agents) {
    if (a.sessionId === 'boss') continue;
    if (a.picker && a.picker.options.length > 0) {
      // Try to use an existing lane or open one. `addLane` returns
      // false if it can't open one (lane-cap hit). In that case fall
      // back to a floating overlay so a permission prompt is never
      // silently swallowed — the picker is BLOCKING the agent and
      // the user has to be able to answer it from somewhere.
      const laneAvailable = hasLane(a.cwd) || addLane(a.cwd);
      const picker = a.picker;
      const onPick = (num: number) => {
        const opt = picker.options.find((o) => o.number === num);
        if (picker.multiSelect && opt?.isCheckbox) {
          // Multi-select toggle: send the digit WITHOUT Enter so the
          // checkbox flips but the picker stays open. Submit (below)
          // commits. No chat echo — toggling isn't an answer yet.
          conn.sendPickerKey(a.pid, String(num), false);
          return;
        }
        // Single-select, or a multi-select action option ("Chat about
        // this"): digit + Enter commits, same as a typed answer.
        conn.sendChat(a.cwd, a.sessionId, a.pid, String(num));
        const label = opt ? `${num}. ${opt.label}` : String(num);
        appendChatMessage('user', label, undefined, displayName(a.cwd));
      };
      const onSubmit = () => {
        // Bare Enter commits the current multi-select selection.
        conn.sendPickerKey(a.pid, '', true);
        appendChatMessage('user', '✓ submitted selection', undefined, displayName(a.cwd));
      };
      if (laneAvailable) {
        setLanePicker(a.cwd, picker, onPick, onSubmit);
        // If we were showing a fallback overlay for this agent, the
        // lane just became available — drop the overlay.
        if (activeFallbackPicker?.sessionId === a.sessionId) closeFallbackPicker();
      } else {
        showFallbackPicker(a, picker, onPick, onSubmit);
      }
    } else {
      setLanePicker(a.cwd, null, () => {});
      // Picker cleared server-side (user answered, or it timed out)
      // — drop our overlay if it was showing this agent's prompt.
      if (activeFallbackPicker?.sessionId === a.sessionId) closeFallbackPicker();
    }
  }
  // Mark any lane whose agent is no longer in the registry as "dead"
  // (input disabled), and pulse the lane tab while ANY of the agents
  // sharing that cwd is currently doing work. Aggregate over all
  // agents matching the cwd — multiple worktrees of the same repo
  // each get their own AgentState row but share a lane, and we want
  // the pulse to fire if any of them is mid-turn.
  eachLane((lane) => {
    if (!lane.cwd) return;
    const matches = agents.filter((a) => a.cwd === lane.cwd);
    const alive = matches.some((a) => !!a.sessionId);
    markLaneDead(lane.cwd, !alive);
    const working = alive && matches.some((a) => a.status === 'active');
    markLaneWorking(lane.cwd, !!working);
  });
});

setInterval(() => {
  const now = Date.now();
  // Cover lane 0's active-agents-bar, the task panel header, and
  // every per-lane chip so the seconds counter ticks every 1s
  // instead of jumping in 3s state-broadcast chunks.
  document.querySelectorAll(
    '#active-agents-bar .active-bar-time, #task-panel .task-header-time, .lane-active-bar .active-bar-time',
  ).forEach((el) => {
    const since = parseInt((el as HTMLElement).dataset.since || '0', 10);
    if (since > 0) el.textContent = formatElapsed(now - since);
  });
}, 1000);

// --- Boss Banner ---

function updateBossBanner(agents: Agent[]) {
  let active = 0, idle = 0, done = 0;
  for (const a of agents) {
    if (a.sessionId === 'boss') continue;
    if (a.status === 'active') active++;
    else if (a.status === 'idle') idle++;
    else if (a.status === 'done') done++;
  }

  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (idle > 0) parts.push(`${idle} idle`);
  if (done > 0) parts.push(`${done} done`);

  const centerEl = document.getElementById('boss-center');
  if (centerEl) centerEl.textContent = parts.join(' \u00b7 ') || 'no agents';

  const thinkEl = document.getElementById('boss-thinking');
  if (thinkEl) {
    thinkEl.innerHTML = bossThinking ? '<span class="boss-thinking"></span> thinking...' : '';
  }
}

let activeBarAnimId = 0;

// Walk this agent's chat history backwards looking for the latest
// tool_use block that has no tool_result block following it — that
// is the tool the agent is currently running. We only consider the
// most recent streaming entry for the agent so completed turns
// don't bleed into the live indicator. Returns null if the agent
// is between tools (e.g. just emitted text and is "thinking").
function inFlightToolFor(cwd: string): string | null {
  // Find the most recent streaming entry for this agent.
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const e = chatHistory[i];
    if (e.agentCwd !== cwd || !e.streaming) continue;
    const blocks = e.verboseBlocks || [];
    if (blocks.length === 0) return null;
    // Walk this entry's blocks in reverse for the last tool_use; if
    // any tool_result lies after it (in normal forward order), the
    // tool is finished. Otherwise it's still running.
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type !== 'tool_use') continue;
      let resolved = false;
      for (let k = j + 1; k < blocks.length; k++) {
        if (blocks[k].type === 'tool_result') { resolved = true; break; }
      }
      if (resolved) return null; // last tool already returned, agent is between tools
      return summarizeToolCall(b.toolName || '', b.input || '');
    }
    return null;
  }
  return null;
}

function updateActiveAgentsBar() {
  const bar = document.getElementById('active-agents-bar');
  if (!bar) return;
  const agents = state.getAgents().filter(a => a.sessionId !== 'boss');
  const groups = groupAgents(agents);
  // Show every active agent in the bar — including those captured by
  // a dedicated lane. The lane tab pulse alone proved too easy to
  // miss; keeping the avatar+timer chip up here ensures there's
  // always one obvious "X is working" signal regardless of layout.
  const activeGroups = groups.filter(g => g.status === 'active');
  if (activeGroups.length === 0) {
    bar.style.display = 'none';
    // Also clear any per-lane active chips. Use the data-active
    // attribute (CSS-driven slide-up) instead of style.display so
    // the collapse transitions smoothly.
    document.querySelectorAll('.lane-active-bar').forEach((el) => {
      const e = el as HTMLElement;
      e.style.removeProperty('display');
      delete e.dataset.active;
      e.innerHTML = '';
    });
    if (activeBarAnimId) { cancelAnimationFrame(activeBarAnimId); activeBarAnimId = 0; }
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  const canvases: { ctx: CanvasRenderingContext2D; frames: string[] }[] = [];

  // Build a chip for one active group. Returns the span element +
  // (optionally) registers a sprite canvas for the shared animation
  // loop. We use this for both the lane-0 bar and per-lane bars so
  // the visual is identical.
  const buildChip = (group: AgentGroup) => {
    const profile = getProfile(group.key);
    const name = profile.name || shortenPath(group.cwd);
    const creatureIdx = resolveCreatureIndex(group.key, CREATURES.length);
    const creature = CREATURES.length > 0 ? CREATURES[creatureIdx] : null;
    const color = agentColor(group.cwd);
    const span = document.createElement('span');
    span.className = 'active-bar-agent';
    span.style.color = color;
    if (creature) {
      const canvas = document.createElement('canvas');
      canvas.width = 15;
      canvas.height = 15;
      canvas.className = 'active-bar-sprite';
      span.appendChild(canvas);
      const ctx = canvas.getContext('2d')!;
      canvases.push({ ctx, frames: creature.frames });
    }
    const strong = document.createElement('strong');
    strong.textContent = name;
    span.appendChild(strong);
    const think = document.createElement('span');
    think.className = 'boss-thinking';
    span.appendChild(think);
    const validSince = group.agents
      .map((a) => a.activeSinceMs || 0)
      .filter((t) => t > 0);
    const since = validSince.length > 0 ? Math.min(...validSince) : 0;
    if (since > 0) {
      const timeEl = document.createElement('span');
      timeEl.className = 'active-bar-time';
      timeEl.dataset.since = String(since);
      timeEl.textContent = formatElapsed(Date.now() - since);
      span.appendChild(timeEl);
    }
    // Live tool activity: surface the in-flight tool call (e.g.
    // "Read page.tsx", "Bash npm test") so the chip tells the user
    // *what* the agent is doing, not just that it's working. Reads
    // the latest streaming verboseBlocks for this agent's cwd.
    const live = inFlightToolFor(group.cwd);
    if (live) {
      const tool = document.createElement('span');
      tool.className = 'active-bar-tool';
      tool.textContent = live;
      tool.title = live;
      span.appendChild(tool);
    }
    return span;
  };

  // Lane-0 bar gets every active group's chip.
  for (const group of activeGroups) {
    bar.appendChild(buildChip(group));
  }

  // Each agent lane that has an active agent gets its own copy of
  // the chip above its input. The chip uses an independent canvas
  // (new buildChip call) so the shared anim loop draws into both.
  // Inactive lanes (or lanes whose agent isn't active) clear out.
  const allLaneBars = document.querySelectorAll('.lane-active-bar') as NodeListOf<HTMLElement>;
  for (const laneBar of allLaneBars) {
    const cwd = laneBar.dataset.laneActive || '';
    const matching = activeGroups.find((g) => g.cwd === cwd);
    laneBar.innerHTML = '';
    // Toggle a data-active attr so CSS can transition the slide-up
    // (max-height + opacity + padding) cleanly. The legacy
    // `style.display` hook is cleared so it can't override the CSS
    // animation chain.
    laneBar.style.removeProperty('display');
    if (matching) {
      laneBar.dataset.active = 'true';
      laneBar.appendChild(buildChip(matching));
    } else {
      delete laneBar.dataset.active;
    }
  }
  if (activeBarAnimId) cancelAnimationFrame(activeBarAnimId);
  let frame = 0;
  let lastSwap = 0;
  function animateBar(ts: number) {
    if (!bar || !bar.isConnected) return;
    if (ts - lastSwap > 800) {
      frame = frame === 0 ? 1 : 0;
      lastSwap = ts;
      for (const c of canvases) {
        const src = c.frames[frame % c.frames.length];
        const img = imageCache.get(src);
        if (img) {
          c.ctx.clearRect(0, 0, 15, 15);
          c.ctx.drawImage(img, 0, 0, 15, 15);
        }
      }
    }
    activeBarAnimId = requestAnimationFrame(animateBar);
  }
  activeBarAnimId = requestAnimationFrame(animateBar);
}

function updateTaskPanel() {
  const panel = document.getElementById('task-panel');
  if (!panel) return;
  // Render every agent that has tasks. Agents with a dedicated lane
  // route into that lane's per-lane task panel; everyone else goes
  // into lane 0's global #task-panel below the chat.
  const agents = state.getAgents().filter(a => a.sessionId !== 'boss' && a.tasks && a.tasks.length > 0);
  const groups = groupAgents(agents);
  const withTasks = groups
    .map(g => ({ group: g, tasks: g.agents.find(a => a.tasks && a.tasks.length > 0)?.tasks || [] }))
    .filter(x => x.tasks.length > 0);

  // Clear all per-lane task panels up-front so an agent that just
  // finished its roadmap doesn't keep stale entries hanging around.
  // Use data-active so the slide-down transition runs cleanly —
  // display swaps would snap and skip the animation.
  document.querySelectorAll('.lane-task-panel').forEach((el) => {
    const e = el as HTMLElement;
    e.innerHTML = '';
    e.style.removeProperty('display');
    delete e.dataset.active;
  });

  // Partition: laned vs not. Laned agents render into their own
  // panel; the rest fall through to the global task panel.
  const lanedTasks = withTasks.filter((x) => hasLane(x.group.cwd));
  const globalTasks = withTasks.filter((x) => !hasLane(x.group.cwd));

  panel.style.removeProperty('display');
  if (globalTasks.length === 0) {
    delete panel.dataset.active;
  } else {
    panel.dataset.active = 'true';
  }
  panel.innerHTML = '';

  const buildSection = ({ group, tasks }: { group: AgentGroup; tasks: NonNullable<Agent['tasks']> }): HTMLElement => {
    const profile = getProfile(group.key);
    const name = profile.name || shortenPath(group.cwd);
    const color = agentColor(group.key);
    const section = document.createElement('div');
    section.className = 'task-section';

    const header = document.createElement('div');
    header.className = 'task-header';
    header.style.color = color;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    header.appendChild(nameSpan);
    const activeSinceCandidates = group.agents.map(a => a.activeSinceMs || 0).filter(t => t > 0);
    const activeSince = activeSinceCandidates.length > 0 ? Math.min(...activeSinceCandidates) : 0;
    const tokens = Math.max(...group.agents.map(a => a.contextTokens || 0));
    const tkStr = formatTokens(tokens);

    const metaEl = document.createElement('span');
    metaEl.className = 'task-header-meta';
    header.appendChild(metaEl);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'task-header-time';
    if (activeSince > 0) {
      timeSpan.dataset.since = String(activeSince);
      timeSpan.textContent = formatElapsed(Date.now() - activeSince);
    }
    const metaParts: (string | HTMLElement)[] = [];
    if (activeSince > 0) metaParts.push(timeSpan);
    if (tkStr) metaParts.push(`↓ ${tkStr} tokens`);
    if (metaParts.length > 0) {
      metaEl.appendChild(document.createTextNode(' ('));
      metaParts.forEach((p, i) => {
        if (i > 0) metaEl.appendChild(document.createTextNode(' · '));
        if (typeof p === 'string') metaEl.appendChild(document.createTextNode(p));
        else metaEl.appendChild(p);
      });
      metaEl.appendChild(document.createTextNode(')'));
    }
    section.appendChild(header);

    // Abandoned todos (scanner-flagged: a later todo already completed,
    // so the agent worked past these) are split out of the active list
    // so a long-dead straggler doesn't make an idle agent look stuck.
    const active = tasks.filter(t => !t.abandoned && (t.status === 'in_progress' || t.status === 'pending'));
    const abandoned = tasks.filter(t => t.abandoned);
    const completed = tasks.filter(t => t.status === 'completed');

    const list = document.createElement('ul');
    list.className = 'task-list';
    for (const t of active) {
      const li = document.createElement('li');
      li.className = `task-item task-${t.status}`;
      const box = document.createElement('span');
      box.className = 'task-box';
      box.textContent = t.status === 'in_progress' ? '■' : '☐';
      li.appendChild(box);
      const text = document.createElement('span');
      text.textContent = t.subject;
      li.appendChild(text);
      list.appendChild(li);
    }
    // Only surface the skipped group WHILE the agent still has real
    // work in flight. Once every non-abandoned todo is done (no active
    // tasks left), the leftover skipped items are pure noise and would
    // make a finished agent look like it has loose ends — so the group
    // auto-hides and the panel reads as a clean "✓ N completed". It
    // reappears if the agent picks up new active work later.
    if (abandoned.length > 0 && active.length > 0) {
      // Collapsed-by-default dimmed group, same affordance as completed.
      // These are pending/in_progress on disk but the agent has moved
      // past them — shown so nothing silently disappears, de-emphasized
      // so they read as "skipped", not "to do".
      const summaryItem = document.createElement('li');
      summaryItem.className = 'task-item task-abandoned-summary';
      summaryItem.textContent = `⊘ ${abandoned.length} skipped`;
      summaryItem.title = 'Pending todos the agent worked past (a later todo is already done). Click to show.';
      summaryItem.style.cursor = 'pointer';
      list.appendChild(summaryItem);

      const abandonedItems: HTMLElement[] = [];
      for (const t of abandoned) {
        const li = document.createElement('li');
        li.className = 'task-item task-abandoned';
        const box = document.createElement('span');
        box.className = 'task-box';
        box.textContent = '⊘';
        li.appendChild(box);
        const text = document.createElement('span');
        text.textContent = t.subject;
        li.appendChild(text);
        li.style.display = 'none';
        list.appendChild(li);
        abandonedItems.push(li);
      }

      const abandonedKey = `taskAbandonedExpanded:${group.key}`;
      if (localStorage.getItem(abandonedKey) === '1') {
        for (const li of abandonedItems) li.style.display = '';
        summaryItem.classList.add('task-abandoned-expanded');
      }
      summaryItem.addEventListener('click', () => {
        const isExpanded = summaryItem.classList.toggle('task-abandoned-expanded');
        localStorage.setItem(abandonedKey, isExpanded ? '1' : '0');
        for (const li of abandonedItems) li.style.display = isExpanded ? '' : 'none';
      });
    }
    if (completed.length > 0) {
      // Render completed milestones too — struck-through and dimmed —
      // so the user sees what got finished, not just a count. Header
      // line stays for visual rhythm, and clicking it toggles the
      // expanded view (collapsed by default to keep the panel tight).
      const summaryItem = document.createElement('li');
      summaryItem.className = 'task-item task-completed-summary';
      summaryItem.textContent = `✓ ${completed.length} completed`;
      summaryItem.style.cursor = 'pointer';
      list.appendChild(summaryItem);

      const completedItems: HTMLElement[] = [];
      for (const t of completed) {
        const li = document.createElement('li');
        li.className = 'task-item task-completed';
        const box = document.createElement('span');
        box.className = 'task-box';
        box.textContent = '✓';
        li.appendChild(box);
        const text = document.createElement('span');
        text.textContent = t.subject;
        li.appendChild(text);
        li.style.display = 'none'; // collapsed by default
        list.appendChild(li);
        completedItems.push(li);
      }

      const expandedKey = `taskCompletedExpanded:${group.key}`;
      const initialExpanded = localStorage.getItem(expandedKey) === '1';
      if (initialExpanded) {
        for (const li of completedItems) li.style.display = '';
        summaryItem.classList.add('task-completed-expanded');
      }

      summaryItem.addEventListener('click', () => {
        const isExpanded = summaryItem.classList.toggle('task-completed-expanded');
        localStorage.setItem(expandedKey, isExpanded ? '1' : '0');
        for (const li of completedItems) li.style.display = isExpanded ? '' : 'none';
      });
    }
    section.appendChild(list);
    return section;
  };

  for (const item of globalTasks) {
    panel.appendChild(buildSection(item));
  }
  for (const item of lanedTasks) {
    const target = laneTaskPanelEl(item.group.cwd);
    if (!target) continue;
    target.style.removeProperty('display');
    target.dataset.active = 'true';
    target.appendChild(buildSection(item));
  }
}

function updateBossRight() {
  const el = document.getElementById('boss-right');
  if (el) {
    el.textContent = lastBossAction;
    el.style.opacity = '0.5';
    setTimeout(() => { if (el.textContent === lastBossAction) el.style.opacity = '0.25'; }, 10000);
  }
}

function applyBossMode() {
  const el = document.getElementById('boss-mode-toggle');
  if (el) {
    el.classList.toggle('mode-manager', bossThinkMode);
    el.classList.toggle('mode-route', !bossThinkMode);
  }
}

function initBossModeToggle() {
  const el = document.getElementById('boss-mode-toggle');
  if (!el) return;
  applyBossMode();
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    bossThinkMode = !bossThinkMode;
    localStorage.setItem('bossThinkMode', bossThinkMode ? '1' : '0');
    applyBossMode();
  });
}

function initBossSprite() {
  const canvas = document.getElementById('boss-sprite') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let frame = 0;
  let lastSwap = 0;

  function drawFrame(f: number) {
    const creature = getBossCreature();
    if (!creature) return;
    const img = imageCache.get(creature.frames[f]);
    if (img) {
      ctx.clearRect(0, 0, 15, 15);
      ctx.drawImage(img, 0, 0, 15, 15);
    }
  }

  function animate(time: number) {
    if (time - lastSwap > 800) {
      frame = (frame + 1) % 2;
      lastSwap = time;
      drawFrame(frame);
    }
    requestAnimationFrame(animate);
  }

  drawFrame(0);
  requestAnimationFrame(animate);

  canvas.style.cursor = 'pointer';
  canvas.title = 'change boss sprite';
  canvas.addEventListener('click', (e) => {
    e.stopPropagation();
    openBossSpritePicker(() => drawFrame(frame));
  });
}

function openBossSpritePicker(onChange: () => void) {
  if (document.querySelector('.boss-picker-overlay')) return;
  const currentId = getBossCreature()?.id || '';
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay boss-picker-overlay';
  const modal = document.createElement('div');
  modal.className = 'picker-modal';
  modal.innerHTML = `<h2 class="picker-title">choose boss sprite</h2><div class="boss-sprite-grid"></div>`;
  const grid = modal.querySelector('.boss-sprite-grid') as HTMLElement;

  for (const c of CREATURES) {
    const tile = document.createElement('div');
    tile.className = 'boss-sprite-tile' + (c.id === currentId ? ' selected' : '');
    tile.title = c.id;
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 15;
    tileCanvas.height = 15;
    const tctx = tileCanvas.getContext('2d')!;
    tctx.imageSmoothingEnabled = false;
    const drawTile = () => {
      const img = imageCache.get(c.frames[0]);
      if (img) {
        tctx.clearRect(0, 0, 15, 15);
        tctx.drawImage(img, 0, 0, 15, 15);
      }
    };
    drawTile();
    const nameEl = document.createElement('div');
    nameEl.className = 'boss-sprite-tile-name';
    nameEl.textContent = c.id;
    tile.appendChild(tileCanvas);
    tile.appendChild(nameEl);
    tile.addEventListener('click', () => {
      bossCreatureId = c.id;
      localStorage.setItem('bossCreatureId', c.id);
      onChange();
      document.body.removeChild(overlay);
    });
    grid.appendChild(tile);
  }

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) document.body.removeChild(overlay);
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      if (overlay.parentElement) document.body.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
    }
  });
  document.body.appendChild(overlay);
}

// --- Agent badge / event rendering ---

function showImageOverlay(src: string) {
  const overlay = document.createElement('div');
  overlay.className = 'image-overlay';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// `mode` = 'badge' renders the avatar + colored name (used for the
// `sending` event so the "to whom" still reads); 'avatar' renders
// just the sprite glyph in the agent's color, with the name in the
// tooltip — used for the `messaged` event where the boss reply text
// itself already names the agent and the redundant "X is working
// on it" line was just noise.
function buildAgentBadgeHtml(cwd: string, fallbackName: string, mode: 'badge' | 'avatar' = 'badge'): string {
  const profile = getProfile(cwd);
  const name = profile.name || fallbackName || shortenPath(cwd);
  const creatureIdx = resolveCreatureIndex(cwd, CREATURES.length);
  const creature = CREATURES.length > 0 ? CREATURES[creatureIdx] : null;
  const spriteSrc = creature ? creature.frames[0] : '';
  const color = agentColor(cwd);
  if (mode === 'avatar' && spriteSrc) {
    return `<span class="chat-agent-sprite chat-agent-sprite-solo" title="${name}" style="color:${color};-webkit-mask-image:url(${spriteSrc});mask-image:url(${spriteSrc})"></span>`;
  }
  if (spriteSrc) {
    return `<span class="chat-agent-badge" style="color:${color}"><span class="chat-agent-sprite" style="-webkit-mask-image:url(${spriteSrc});mask-image:url(${spriteSrc})"></span><strong>${name}</strong></span>`;
  }
  return `<strong style="color:${color}">${name}</strong>`;
}

function buildAgentEventHtml(detail: string, event: string): string {
  const agents = state.getAgents();

  let targetName = '';
  if (event === 'sending') {
    const match = detail.match(/^To ([^:]+):/);
    if (match) targetName = match[1].trim();
  }

  for (const a of agents) {
    if (a.sessionId === 'boss') continue;
    const name = displayName(a.cwd);
    const cwdParts = a.cwd.split('/');
    const shortPath = cwdParts.slice(-2).join('/');

    let matched = false;
    if (event === 'sending' && targetName) {
      matched = targetName === name || targetName === shortenPath(a.cwd) || targetName === shortPath;
    } else {
      matched = detail.includes(name) || detail.includes(shortenPath(a.cwd)) || detail.includes(shortPath);
    }

    if (matched) {
      const badge = buildAgentBadgeHtml(a.cwd, name);
      if (event === 'messaged') {
        // Just the avatar — the boss reply text already names the
        // agent in plain prose (e.g. "Routing to cloover-installer
        // — continuing banner work."), so an explicit "X is working
        // on it" line right below was redundant chatter. The lone
        // avatar is the glance-marker that boss kicked the work
        // off; hover for the agent name.
        return buildAgentBadgeHtml(a.cwd, name, 'avatar');
      } else if (event === 'sending') {
        const msgStart = detail.indexOf('\n');
        const msgText = msgStart >= 0 ? detail.slice(msgStart + 1) : '';
        return badge + ' <span class="chat-agent-folder">' + shortenPath(a.cwd) + '</span>' +
          (msgText ? '<div class="chat-sent-msg">' + renderMarkdown(msgText) + '</div>' : '');
      }
    }
  }
  return detail;
}

// Click boss frame = deselect agent, focus boss
document.getElementById('boss-frame')?.addEventListener('click', () => {
  selectedCwd = null;
  selectedSessionId = null;
  selectedPid = null;
  updateChatTarget();
  updateFrameSelection();
  renderChatHistory();
});

// Global zoom is retired — each section has inline − / + controls in its
// corner now. Per-section scales are applied inline on their own elements
// and override the root --ui-scale for their descendants only.


initMusic(musicEnabled);
setMusicDither(musicDither);
initLinear(
  linearEnabled,
  {
    getSelectedAgent: () => {
      if (!selectedCwd) return null;
      // Resolve display name from state if we have one; falls back to basename.
      const agents = state.getAgents();
      const match = agents.find((a) => a.cwd === selectedCwd);
      const name = match?.name || (selectedCwd.split('/').filter(Boolean).pop() ?? '');
      return { cwd: selectedCwd, sessionId: selectedSessionId, pid: selectedPid, name, color: agentColor(selectedCwd) };
    },
    getAllAgents: () => {
      // Real agents only: skip the synthetic boss row, and skip anything
      // that's already been marked done. Each entry carries its assigned
      // palette color so the menu chips render in-tint.
      return state.getAgents()
        .filter((a) => a.sessionId !== 'boss' && a.status !== 'done')
        .map((a) => {
          const fallback = a.cwd.split('/').filter(Boolean).pop() ?? a.cwd;
          return { cwd: a.cwd, name: a.name || fallback, color: agentColor(a.cwd) };
        });
    },
    sendChatToSelected: (text) => {
      if (!selectedCwd || !selectedSessionId || selectedPid === null) return false;
      return conn.sendChat(selectedCwd, selectedSessionId, selectedPid, text);
    },
    spawnAgentWithMessage: (text) => {
      // Queue first so the spawn_agent_response handler can bind it to
      // the chosen folder the moment the server replies.
      queuedSpawnMessages.push(text);
      const spawnBtn = document.getElementById('new-agent-btn');
      if (spawnBtn) spawnBtn.classList.add('spawning');
      conn.spawnAgent(false, true); // openInTerminal=false, skipPermissions=yolo
    },
    sendToBoss: (text) => conn.sendBossMessage(text, undefined, bossThinkMode),
  },
);
setMusicLyrics(musicLyrics);
setMusicSource(musicSource);
setMusicStyle(musicStyle);
// Initialize the modular split-tree layout. Sections marked with
// data-layout-section get parked under #app and rendered into a
// recursive split tree. Drag handles + dividers are wired up here.
const _appEl = document.getElementById('app');
const layoutAPI = _appEl
  ? initLayout({
      host: _appEl,
      knownSections: ['agent-grid', 'chat'],
    })
  : null;
// Make the API available to other modules that need to query layout
// state (e.g. linear.ts re-renders when its split orientation changes).
(window as unknown as { __layout?: typeof layoutAPI }).__layout = layoutAPI;

// Per-section content-scale controls (the −/+ buttons that scale a
// section's interior — agent cards, avatars, music artwork, etc.).
// Independent of the layout system: works on sections inside layout
// leaves AND on chat-internal regions like #active-agents-bar.
initSectionScales();

// Environment health check pill + diagnostics modal. Fetches
// /api/preflight on boot and every 30s, so missing deps (tmux, claude,
// etc.) are visible without the user having to grep the codebase.
initPreflight();

// Agent-grid equal-share layout. Every frame gets the same slot via
// a CSS grid with cols × rows computed from the agent count + the
// container's aspect ratio. Cells aim for a slightly-landscape
// (~1.4) aspect so the sprite stacks cleanly above the name+branch.
// A ResizeObserver re-applies the split whenever the grid changes
// size; renderAgentGrid() also calls applyAgentGridLayout() after
// it stamps new frames so a fresh count picks the right split
// without waiting for a layout tick.
{
  const grid = document.getElementById('agent-grid');
  if (grid) {
    const ro = new ResizeObserver(() => {
      applyAgentGridLayout();
    });
    ro.observe(grid);
    window.addEventListener('lane-resize-end', () => {
      applyAgentGridLayout();
    });
  }
}

// Pick the cols × rows split that produces cells closest to a
// target aspect ratio (~1.4 — slightly landscape, since the sprite
// stacks above name + branch). Returns {cols, rows} where
// cols × rows ≥ count (extra cells just stay empty).
function computeAgentGridLayout(count: number, W: number, H: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 1, rows: 1 };
  if (W <= 0 || H <= 0) return { cols: count, rows: 1 };
  const target = 1.4;
  let best = { cols: 1, rows: count };
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellAspect = (W / cols) / (H / rows);
    const score = Math.abs(Math.log(cellAspect / target));
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

function applyAgentGridLayout(): void {
  const grid = document.getElementById('agent-grid');
  if (!grid) return;
  const r = grid.getBoundingClientRect();
  const count = grid.querySelectorAll('.agent-frame').length;
  const { cols, rows } = computeAgentGridLayout(count, r.width, r.height);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  grid.dataset.gridMode = 'fill';
  grid.style.setProperty('--grid-h', `${Math.round(r.height)}px`);
}

// Drag-and-drop folder/file paths into the chat input. Uses text/uri-list
// from the dataTransfer (which Finder fills with file:// URIs) — works
// reliably in WKWebView; falls back to file names elsewhere. Block-
// scoped to avoid colliding with the module-level `chatInput` const.
{
  const _chatInput = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (_chatInput) initFileDrop(_chatInput);
}

// Chat branching — initialize lanes container, wire the drop target,
// hook the user-sent custom event so messages typed in agent lanes
// land in chatHistory with a cwd attached. Runs after section-drag
// so the chat region's #chat-lanes is in its final position when we
// touch it.
initLanes({
  resolveAgent: (cwd) => {
    const agents = state.getAgents();
    const match = agents.find((a) => a.cwd === cwd);
    if (!match) return null;
    return {
      sessionId: match.sessionId,
      pid: match.pid,
      name: match.name || (cwd.split('/').filter(Boolean).pop() ?? cwd),
      color: agentColor(cwd),
    };
  },
  sendChat: (cwd, sessionId, pid, text) => conn.sendChat(cwd, sessionId, pid, text),
  sendChatWithImages: (cwd, sessionId, pid, text, images) => conn.sendChatWithImages(cwd, sessionId, pid, text, images),
  hasImages: () => hasImages(),
  getImagesBase64: () => getImages().map((i) => i.base64),
  getImagesDataUrls: () => getImages().map((i) => i.dataUrl),
  clearImages: () => clearImages(),
  agentColor: (cwd) => agentColor(cwd),
  // Lane tab `>` button — same select + attach as the agent frame's
  // term button. Resolve the agent by cwd (the lane id) so the pid is
  // current even if the frame has since re-rendered.
  attachTerminal: (cwd) => {
    const match = state.getAgents().find((a) => a.cwd === cwd);
    if (!match) return;
    selectedCwd = cwd;
    selectedSessionId = match.sessionId;
    selectedPid = match.pid;
    updateChatTarget();
    updateFrameSelection();
    conn.attachAgent(match.pid);
  },
  onLanesChanged: () => {
    renderAgentGrid(state.getAgents());
    renderChatHistory();
    renderChatLinkBar();
  },
});

const _laneContainer = document.getElementById('chat-lanes');
if (_laneContainer) {
  setupLaneDropTarget(_laneContainer, (cwd) => {
    addLane(cwd);
  });
}

// User sent a message via an agent lane's input — push into
// chatHistory with the agent cwd so the renderer routes it back into
// the same lane on the next render tick.
window.addEventListener('lanes:user-sent', (e) => {
  const detail = (e as CustomEvent).detail as { cwd: string; target: string; text: string; images?: string[] };
  appendChatMessage('user', detail.text, detail.images, detail.target);
  // Patch the most-recently-pushed entry with cwd for lane routing
  // so the renderer routes the echo (and its image thumbnail) back
  // into the originating lane instead of falling through to lane 0.
  const last = chatHistory[chatHistory.length - 1];
  if (last && last.role === 'user') last.agentCwd = detail.cwd;
  // Sent messages from agent lanes also feed the shared inputHistory
  // so ArrowUp / ArrowDown history navigation works inside lane inputs
  // — same affordance as the boss chat-input.
  if (detail.text) rememberInInputHistory(detail.text);
});

// ArrowUp / ArrowDown history navigation for agent-lane inputs. The boss
// #chat-input has its own bound listener (line ~2441). Lane inputs are
// created dynamically by lanes.ts, so we attach via a delegated keydown
// on document. Per-input cursor state lives in a WeakMap so each lane
// remembers its own position in the history.
const _laneHistoryState = new WeakMap<HTMLTextAreaElement, { index: number; saved: string }>();
// ESC in a lane input — interrupt the lane's agent (send Escape to
// its tmux pane, same as pressing ESC inside Claude Code). Mirrors
// the global chat-input ESC handler; lane inputs have their own
// implicit "selected" agent (the lane they live in) so ESC there
// should target the lane's agent, not whatever was last selected
// globally. This used to call stopAgent — which actually kills the
// tmux session — which is why ESC was closing agents. The user
// expectation is interrupt-the-current-thought, not kill-the-agent.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const t = e.target as HTMLElement | null;
  if (!t || !(t instanceof HTMLTextAreaElement)) return;
  if (!t.classList.contains('lane-input')) return;
  const cwd = (t.closest('.lane') as HTMLElement | null)?.dataset.laneId;
  if (!cwd || cwd === 'general') return; // lane 0: fall through to global handler
  const agent = state.getAgents().find((a) => a.cwd === cwd);
  if (agent && agent.pid > 0) {
    e.preventDefault();
    conn.interruptAgent(agent.pid);
  }
}, true);

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (!t || !(t instanceof HTMLTextAreaElement)) return;
  if (!t.classList.contains('lane-input')) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  // Don't intercept when the user is mid-line in a multi-line message
  // — only navigate history when the cursor is on the first / last
  // physical line of the textarea (matches a terminal's behaviour).
  const onFirstLine = !t.value.slice(0, t.selectionStart ?? 0).includes('\n');
  const onLastLine = !t.value.slice(t.selectionEnd ?? t.value.length).includes('\n');
  if (e.key === 'ArrowUp' && !onFirstLine) return;
  if (e.key === 'ArrowDown' && !onLastLine) return;
  let st = _laneHistoryState.get(t);
  if (!st) { st = { index: -1, saved: '' }; _laneHistoryState.set(t, st); }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (inputHistory.length === 0) return;
    if (st.index === -1) {
      st.saved = t.value;
      st.index = inputHistory.length - 1;
    } else if (st.index > 0) {
      st.index--;
    }
    t.value = inputHistory[st.index];
    t.dispatchEvent(new Event('input', { bubbles: true })); // trigger autoresize
    return;
  }
  // ArrowDown
  e.preventDefault();
  if (st.index === -1) return;
  if (st.index < inputHistory.length - 1) {
    st.index++;
    t.value = inputHistory[st.index];
  } else {
    st.index = -1;
    t.value = st.saved;
  }
  t.dispatchEvent(new Event('input', { bubbles: true }));
}, true);
// Reset history cursor on any printable edit so a recalled message that
// the user starts editing isn't snapped back when they hit ArrowUp again.
//
// IMPORTANT: only reset on REAL user input. The history-nav handler
// above dispatches a programmatic `new Event('input')` to trigger
// autoresize after replacing the textarea value — those events are
// plain `Event` objects with no `inputType`, while real keystrokes
// fire `InputEvent` instances ('insertText' / 'deleteContentBackward'
// / etc.). Without this guard the reset fires on every history
// arrow press, snapping `st.index` back to -1, which made ArrowUp
// only ever recall the most recent message (it could never walk
// further back, because step 2 saw -1 and reset to N-1 again).
document.addEventListener('input', (e) => {
  const ie = e as InputEvent;
  if (!ie.inputType) return;
  const t = e.target as HTMLElement | null;
  if (!t || !(t instanceof HTMLTextAreaElement)) return;
  if (!t.classList.contains('lane-input')) return;
  const st = _laneHistoryState.get(t);
  if (st && st.index !== -1) st.index = -1;
});

// When a lane is closed, the agent's frame in the grid needs to lose
// its `.in-lane` class — re-render once.
window.addEventListener('lanes:removed', () => {
  renderAgentGrid(state.getAgents());
  renderChatHistory();
});

// Slash-command autocomplete + Tab/Arrow handling for any focused
// lane input. Delegated at document level so lane inputs (which are
// created dynamically) automatically share the global #chat-input's
// autocomplete UX without each lane wiring it independently. The
// autocomplete dropdown element is moved into whichever bar has
// focus so its `bottom: 100%` positioning anchors to the right
// input.
// Clicking anywhere in a lane (history area, tab, padding) should
// behave like "I'm working with this lane": select its agent and
// focus the lane's input. Without this, only Tab or clicking the
// input itself updates selection — clicking on a chat message did
// nothing, which felt broken.
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const lane = target.closest('.lane') as HTMLElement | null;
  if (!lane) return;
  const cwd = lane.dataset.laneId;
  if (!cwd || cwd === 'general') return;
  // Skip clicks on tab close/swap controls and links — they have
  // their own behavior and shouldn't steal focus.
  if (target.closest('.lane-tab-close')) return;
  if (target.tagName === 'A') return;
  if (cwd !== selectedCwd) {
    const ag = state.getAgents().find((a) => a.cwd === cwd);
    if (ag) {
      selectedCwd = ag.cwd;
      selectedSessionId = ag.sessionId;
      selectedPid = ag.pid;
      updateChatTarget();
      renderAgentGrid(state.getAgents());
    }
  }
  // If focus isn't already in this lane's input, move it there.
  const input = lane.querySelector('.lane-input') as HTMLTextAreaElement | null;
  if (input && document.activeElement !== input && !target.classList.contains('lane-input')) {
    // Don't steal focus from text selection — only auto-focus
    // when the click landed on a non-text area (history padding,
    // tab title) or the input is empty.
    const sel = window.getSelection();
    if (!sel || sel.toString().length === 0) input.focus();
  }
});

document.addEventListener('focusin', (e) => {
  const t = e.target as HTMLElement;
  const imageQueue = document.getElementById('image-queue');

  if (t.classList?.contains('lane-input')) {
    const lane = t.closest('.lane') as HTMLElement | null;
    const bar = t.closest('.lane-bar') as HTMLElement | null;
    if (bar && autocompleteEl.parentElement !== bar) {
      bar.appendChild(autocompleteEl);
      autocompleteEl.style.display = 'none';
      autocompleteMatches = [];
      autocompleteIndex = -1;
    }
    // Re-parent the image queue too so paste-staged thumbnails
    // appear right above the focused lane's input, not always in
    // lane 0. The element keeps its id so addImage/clearImages
    // continue to target the same DOM node.
    if (lane && bar && imageQueue && imageQueue.parentElement !== lane) {
      lane.insertBefore(imageQueue, bar);
    }
    // Auto-select the lane's agent so cwd-targeting features
    // (Linear, send-to-agent, image queue badge, etc.) reflect
    // wherever the user is actively typing.
    const cwd = lane?.dataset.laneId;
    if (cwd && cwd !== 'general' && cwd !== selectedCwd) {
      const ag = state.getAgents().find((a) => a.cwd === cwd);
      if (ag) {
        selectedCwd = ag.cwd;
        selectedSessionId = ag.sessionId;
        selectedPid = ag.pid;
        updateChatTarget();
        renderAgentGrid(state.getAgents());
      }
    }
  } else if (t.id === 'chat-input') {
    const globalBar = document.getElementById('chat-bar');
    if (globalBar && autocompleteEl.parentElement !== globalBar) {
      globalBar.appendChild(autocompleteEl);
      autocompleteEl.style.display = 'none';
      autocompleteMatches = [];
      autocompleteIndex = -1;
    }
    const laneZero = document.querySelector('.lane.lane-zero');
    if (laneZero && globalBar && imageQueue && imageQueue.parentElement !== laneZero) {
      laneZero.insertBefore(imageQueue, globalBar);
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (t.classList?.contains('lane-input')) {
    updateAutocomplete(t.value);
  }
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (!t.classList?.contains('lane-input')) return;

  if (e.key === 'Tab') {
    e.preventDefault();
    if (autocompleteMatches.length > 0) {
      applyAutocomplete(t);
      return;
    }
    cycleAllFocus(e.shiftKey);
    return;
  }

  if (autocompleteMatches.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteIndex = Math.min(autocompleteIndex + 1, autocompleteMatches.length - 1);
      highlightAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteIndex = Math.max(autocompleteIndex - 1, 0);
      highlightAutocomplete();
      return;
    }
    if (e.key === 'Escape') {
      autocompleteEl.style.display = 'none';
      autocompleteMatches = [];
      autocompleteIndex = -1;
      return;
    }
  }
});

// Slash command typed in an agent lane's input. Two flavors:
//
//   1. Built-in bitwise commands (/help, /clear, /xp, /rebuild, etc.) —
//      execute locally in COMMANDS. We re-target selectedCwd to the
//      lane's agent for the duration so cwd-aware commands like
//      /pr-review hit the lane's agent rather than the globally
//      selected one.
//
//   2. Everything else (/buildremote, /btw, /compact, /plan, …) —
//      forward to the lane's agent as a regular chat message. These
//      are Claude Code slash commands (built-in or project-defined)
//      that the agent itself interprets; bitwise must not swallow
//      them. The previous version rejected anything not in COMMANDS
//      as "unknown command", so no Claude Code slash command typed
//      in a lane input ever reached its terminal — total silent
//      failure.
window.addEventListener('lanes:slash', (e) => {
  const detail = (e as CustomEvent).detail as { text: string; cwd: string };
  const text = (detail?.text || '').trim();
  if (!text.startsWith('/')) return;
  const parts = text.split(/\s+/);
  const cmdName = parts[0];
  const args = parts.slice(1).join(' ');
  const cmd = COMMANDS.find((c) => c.name === cmdName);

  const agents = state.getAgents();
  const target = agents.find((a) => a.cwd === detail.cwd);

  if (cmd) {
    // Built-in: execute locally, with selection re-targeted at the lane.
    const prevCwd = selectedCwd;
    const prevSession = selectedSessionId;
    const prevPid = selectedPid;
    if (target) {
      selectedCwd = target.cwd;
      selectedSessionId = target.sessionId;
      selectedPid = target.pid;
    }
    try {
      cmd.execute(args);
    } finally {
      selectedCwd = prevCwd;
      selectedSessionId = prevSession;
      selectedPid = prevPid;
    }
    return;
  }

  // Passthrough: forward to the lane's agent verbatim so Claude Code
  // sees the slash command and interprets it (whether it's a built-in
  // like /compact or a project-defined command like /buildremote).
  if (!target) {
    appendChatMessage('system', `no agent at ${detail.cwd} to receive ${cmdName}`);
    return;
  }
  const ok = conn.sendChat(target.cwd, target.sessionId, target.pid, text);
  if (!ok) {
    appendChatMessage('system', `failed to send ${cmdName} (disconnected?)`);
    return;
  }
  // Echo into the lane's chat history so the user sees what they sent,
  // same shape as plain-text sends from the lane input.
  window.dispatchEvent(new CustomEvent('lanes:user-sent', {
    detail: { cwd: target.cwd, target: displayName(target.cwd), text },
  }));
});

// --- Agent frame tracking ---
interface AgentFrame {
  element: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  creatureIndex: number;
  currentFrame: number;
  animTimer: number;
}

const agentFrames = new Map<string, AgentFrame>();

interface AgentGroup {
  cwd: string;
  key: string;
  worktree: string;
  agents: Agent[];
  status: string;
  currentTask: string;
  commitsToday: number;
  pushesToday: number;
  mergesToday: number;
  totalCommits: number;
  branch: string;
  count: number;
  activeSubs: number;
  totalSubs: number;
}

function groupKey(a: Agent): string {
  return a.worktree ? `${a.cwd}::worktree::${a.worktree}` : a.cwd;
}

function groupAgents(agents: Agent[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const a of agents) {
    const key = groupKey(a);
    let g = groups.get(key);
    if (!g) {
      g = { cwd: a.cwd, key, worktree: a.worktree || '', agents: [], status: 'done', currentTask: '', commitsToday: 0, pushesToday: 0, mergesToday: 0, totalCommits: 0, branch: '', count: 0, activeSubs: 0, totalSubs: 0 };
      groups.set(key, g);
    }
    g.agents.push(a);
    g.count++;
    if (a.currentTask) g.currentTask = a.currentTask;
    if (a.status === 'active') g.status = 'active';
    else if (a.status !== 'done' && g.status !== 'active') g.status = 'idle';
    g.commitsToday = Math.max(g.commitsToday, a.commitsToday || 0);
    g.pushesToday = Math.max(g.pushesToday, a.pushesToday || 0);
    g.mergesToday = Math.max(g.mergesToday, a.mergesToday || 0);
    g.totalCommits = Math.max(g.totalCommits, a.totalCommits || 0);
    if (a.branch) g.branch = a.branch;
    g.activeSubs += a.activeSubs || 0;
    g.totalSubs += a.totalSubs || 0;
  }
  return Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key));
}

// --- Agent selection ---

// Tab handler. Two modes depending on whether any agent lanes are
// open:
//   no lanes → original behavior: cycle selectedCwd through every
//     agent in the grid (and the boss/null state). Focus stays on
//     the global #chat-input.
//   lanes open → cycle ONLY between the open panels (lane 0 + each
//     agent lane). Don't visit grid-only agents — the user explicitly
//     pulled the panels they care about into the chat region.
function cycleAllFocus(back: boolean): void {
  if (!hasAnyAgentLane()) {
    back ? cycleAgentSelectionBack() : cycleAgentSelection();
    return;
  }

  let order = laneOrder(); // [null, "cwd1", "cwd2", ...] in DOM order
  // Skip lane 0 if collapsed (user can't see/use it). Lane 0 now
  // uses the same .lane-collapsed mechanism as agent lanes; its
  // entry in collapsedSet is keyed by the sentinel id 'general'.
  if (isLaneCollapsed('general')) {
    order = order.filter((c) => c !== null);
  }
  // Skip any individually-collapsed agent lanes — the strip has no
  // input to focus, so cycling onto it would feel broken.
  order = order.filter((c) => c === null || !isLaneCollapsed(c));
  if (order.length === 0) return;

  // Find current position. Prefer the focused lane input; fall back
  // to selectedCwd; default to lane 0.
  const active = document.activeElement as HTMLElement | null;
  let currentIdx = 0;
  if (active?.classList?.contains('lane-input')) {
    const cwd = (active.closest('.lane') as HTMLElement | null)?.dataset.laneId;
    if (cwd && cwd !== 'general') {
      const idx = order.indexOf(cwd);
      if (idx !== -1) currentIdx = idx;
    }
  } else if (selectedCwd) {
    const idx = order.indexOf(selectedCwd);
    if (idx !== -1) currentIdx = idx;
  }

  let nextIdx = back ? currentIdx - 1 : currentIdx + 1;
  if (nextIdx < 0) nextIdx = order.length - 1;
  if (nextIdx >= order.length) nextIdx = 0;

  const targetCwd = order[nextIdx];
  if (targetCwd === null) {
    selectedCwd = null;
    selectedSessionId = null;
    selectedPid = null;
    chatInput.focus();
  } else {
    const ag = state.getAgents().find((a) => a.cwd === targetCwd);
    if (ag) {
      selectedCwd = ag.cwd;
      selectedSessionId = ag.sessionId;
      selectedPid = ag.pid;
    } else {
      selectedCwd = targetCwd;
      selectedSessionId = null;
      selectedPid = null;
    }
    focusLaneInput(targetCwd);
  }
  updateChatTarget();
  renderAgentGrid(state.getAgents());
}

function cycleAgentSelection() {
  const agents = state.getAgents().filter(a => a.sessionId !== 'boss');
  const groups = groupAgents(agents);
  if (groups.length === 0) return;

  const currentIdx = selectedCwd ? groups.findIndex(g => g.key === selectedCwd) : -1;
  const nextIdx = currentIdx + 1;

  if (nextIdx >= groups.length) {
    selectedCwd = null;
    selectedSessionId = null;
    selectedPid = null;
  } else {
    const group = groups[nextIdx];
    selectedCwd = group.key;
    selectedSessionId = group.agents[0].sessionId;
    selectedPid = group.agents[0].pid;
  }
  updateChatTarget();
  updateFrameSelection();
}

function cycleAgentSelectionBack() {
  const agents = state.getAgents().filter(a => a.sessionId !== 'boss');
  const groups = groupAgents(agents);
  if (groups.length === 0) return;

  const currentIdx = selectedCwd ? groups.findIndex(g => g.key === selectedCwd) : -1;

  if (currentIdx <= 0) {
    if (currentIdx === 0) {
      selectedCwd = null;
      selectedSessionId = null;
      selectedPid = null;
    } else {
      const group = groups[groups.length - 1];
      selectedCwd = group.key;
      selectedSessionId = group.agents[0].sessionId;
      selectedPid = group.agents[0].pid;
    }
  } else {
    const group = groups[currentIdx - 1];
    selectedCwd = group.key;
    selectedSessionId = group.agents[0].sessionId;
    selectedPid = group.agents[0].pid;
  }
  updateChatTarget();
  updateFrameSelection();
}

function updateFrameSelection() {
  for (const [k, frame] of agentFrames) {
    frame.element.classList.toggle('selected', k === selectedCwd);
    const faded = soloMode && selectedCwd && k !== selectedCwd;
    frame.element.classList.toggle('solo-faded', !!faded);
  }
  // The boss isn't in agentFrames (it's a static #boss-frame element),
  // so it never picked up the cream-checker `selected` strip when the
  // user was targeting boss (selectedCwd === null). Mirror the same
  // class on it so the highlight is consistent across all frames.
  const bossFrame = document.getElementById('boss-frame');
  if (bossFrame) bossFrame.classList.toggle('selected', selectedCwd === null);
}

// --- Solo mode toggle ---
function applySoloMode() {
  const btn = document.getElementById('solo-btn');
  if (btn) {
    btn.textContent = soloMode ? '●' : '○';
    btn.classList.toggle('active', soloMode);
  }
  renderChatHistory();
  updateFrameSelection();
}
applySoloMode();

document.getElementById('solo-btn')?.addEventListener('click', () => {
  soloMode = !soloMode;
  localStorage.setItem('soloMode', soloMode ? '1' : '0');
  applySoloMode();
});

// --- Verbose mode toggle ---
function applyVerboseMode() {
  const btn = document.getElementById('verbose-btn');
  if (btn) {
    btn.textContent = verboseMode ? '●' : '○';
    btn.classList.toggle('active', verboseMode);
  }
  renderChatHistory();
}
applyVerboseMode();

document.getElementById('verbose-btn')?.addEventListener('click', () => {
  verboseMode = !verboseMode;
  localStorage.setItem('verboseMode', verboseMode ? '1' : '0');
  applyVerboseMode();
});

// --- Avatars toggle ---
function applyAvatarsHidden() {
  const btn = document.getElementById('avatars-btn');
  if (btn) {
    btn.textContent = avatarsHidden ? '○' : '●';
    btn.classList.toggle('active', !avatarsHidden);
  }
  document.body.classList.toggle('avatars-hidden', avatarsHidden);
}
applyAvatarsHidden();

// --- Chat target label ---

function updateChatTarget() {
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;

  let labelEl = document.querySelector('.chat-target-label') as HTMLElement;
  if (!labelEl) {
    labelEl = document.createElement('span');
    labelEl.className = 'chat-target-label';
    document.getElementById('chat-bar')!.appendChild(labelEl);
  }

  if (selectedCwd) {
    const profile = getProfile(selectedCwd);
    const name = profile.name || shortenPath(selectedCwd);
    labelEl.textContent = '→ ' + name;
    chatInput.placeholder = 'message ' + name + '...';
  } else {
    labelEl.textContent = '→ boss';
    chatInput.placeholder = 'talk to the boss...';
  }
  renderChatLinkBar();
  renderChatHistory();
}

// --- Pinned local link bar ---
//
// Shows the localhost URLs of dev servers the selected agent started
// (auto-detected by the scanner into agent.devUrls; the daemon probes them
// each tick, so a closed server's chip drops out on its own) as clickable
// links pinned below the chat tab, so you don't have to scroll the chat to
// find which port a server is on. Manual per-cwd pins (localStorage) are
// listed first and are only ever removed by hand.

// Which cwd's bar is currently having a manual pin typed, if any. Keyed by cwd
// so a ~3s state tick re-rendering the other bars doesn't steal focus from the
// input the user is typing in.
let chatLinkEditingCwd: string | null = null;

// Manual pins are stored per-cwd as a JSON array of URLs, shown alongside the
// auto-detected chips (deduped) so you can add servers detection missed.
function chatLinkPinsKey(cwd: string): string {
  return `cloovies:devurls:${cwd}`;
}

function loadChatLinkPins(cwd: string): string[] {
  try {
    const raw = localStorage.getItem(chatLinkPinsKey(cwd));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function saveChatLinkPins(cwd: string, pins: string[]) {
  if (pins.length) localStorage.setItem(chatLinkPinsKey(cwd), JSON.stringify(pins));
  else localStorage.removeItem(chatLinkPinsKey(cwd));
}

// Trim the scheme for a compact label; the full URL stays in the title.
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// Friendly chip label for well-known dev servers, keyed off the port.
// Storybook instances run in the 60xx band, so "Storybook 6016" reads better
// than a bare host:port (and the port keeps multiple Storybooks distinct).
// Anything unrecognized falls back to host:port.
function chipLabel(url: string): string {
  let port = 0;
  try { port = parseInt(new URL(url).port, 10) || 0; } catch { /* leave 0 */ }
  if (port >= 6000 && port <= 6199) return `Storybook ${port}`;
  return displayUrl(url);
}

function openInBrowser(url: string) {
  // Route through the daemon so the link opens in the default browser even
  // inside the native macOS wrapper (where window.open is a no-op). Falls
  // back to window.open for a plain browser context. Absolute host mirrors
  // the other daemon fetches in this file (no Vite proxy in dev).
  void fetch('http://localhost:3333/api/open-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }).catch(() => {
    window.open(url, '_blank', 'noopener');
  });
}

// Manual pins first (so you can promote a favourite), then auto-detected
// origins that aren't already pinned. Deduped, preserving order.
function resolveDevUrls(cwd: string | null): { url: string; pinned: boolean }[] {
  if (!cwd) return [];
  const pins = loadChatLinkPins(cwd);
  const detected = state.getAgents().find((a) => a.cwd === cwd)?.devUrls || [];
  const seen = new Set<string>();
  const out: { url: string; pinned: boolean }[] = [];
  for (const url of pins) {
    if (seen.has(url)) continue;
    seen.add(url); out.push({ url, pinned: true });
  }
  for (const url of detected) {
    if (seen.has(url)) continue;
    seen.add(url); out.push({ url, pinned: false });
  }
  return out;
}

function makeLinkChip(url: string): HTMLButtonElement {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'chat-link';
  link.title = 'open ' + url + ' in browser';
  link.textContent = '↗ ' + chipLabel(url);
  link.addEventListener('click', () => openInBrowser(url));
  return link;
}

// Populate a single link-bar element for the given cwd with one chip per
// server. Shared by the per-agent-lane bars (each keyed to its own lane's cwd)
// and the lane-zero bar (keyed to the currently selected agent).
function renderLinkBar(bar: HTMLElement, cwd: string | null) {
  // Don't clobber the input while THIS bar is mid-edit.
  if (cwd && chatLinkEditingCwd === cwd) return;

  const links = cwd ? resolveDevUrls(cwd) : [];
  if (!cwd || links.length === 0) {
    bar.style.display = 'none';
    bar.replaceChildren();
    return;
  }

  bar.style.display = '';
  bar.replaceChildren();

  for (const { url, pinned } of links) {
    const chip = document.createElement('span');
    chip.className = 'chat-link-chip';
    chip.appendChild(makeLinkChip(url));
    // Only manual pins are removable; auto-detected chips reappear next scan.
    if (pinned) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'chat-link-btn';
      rm.textContent = '×';
      rm.title = 'remove pinned link';
      rm.addEventListener('click', () => {
        saveChatLinkPins(cwd, loadChatLinkPins(cwd).filter((u) => u !== url));
        renderChatLinkBar();
      });
      chip.appendChild(rm);
    }
    bar.appendChild(chip);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chat-link-btn';
  add.textContent = '✎';
  add.title = 'pin a link manually';
  add.addEventListener('click', () => startChatLinkEdit(bar, cwd));
  bar.appendChild(add);
}

// Refresh every link bar: one per open agent lane (its own agent's URLs),
// plus the lane-zero bar for a selected agent that has no open lane of its
// own (so links still show when you chat via the main bar). When a lane IS
// open for the selected agent, its own bar covers it — so we blank the
// lane-zero one to avoid showing the links twice.
function renderChatLinkBar() {
  document.querySelectorAll<HTMLElement>('[data-lane-link]').forEach((el) => {
    renderLinkBar(el, el.dataset.laneLink || null);
  });

  const main = document.getElementById('chat-link-bar');
  if (main) {
    const mainCwd = selectedCwd && !hasLane(selectedCwd) ? selectedCwd : null;
    renderLinkBar(main, mainCwd);
  }
}

function startChatLinkEdit(bar: HTMLElement, cwd: string) {
  chatLinkEditingCwd = cwd;
  bar.style.display = '';
  bar.replaceChildren();

  const input = document.createElement('input');
  input.className = 'chat-link-input';
  input.placeholder = 'pin a link, e.g. http://localhost:3000';
  input.spellcheck = false;

  const commit = (save: boolean) => {
    if (chatLinkEditingCwd !== cwd) return;
    if (save) {
      const v = input.value.trim();
      if (v) {
        const pins = loadChatLinkPins(cwd);
        if (!pins.includes(v)) { pins.push(v); saveChatLinkPins(cwd, pins); }
      }
    }
    chatLinkEditingCwd = null;
    renderChatLinkBar();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));

  bar.appendChild(input);
  input.focus();
}

// --- Welcome sprites ---

function animateWelcomeSprites(container: Element) {
  if (CREATURES.length === 0) return;
  const canvases: { ctx: CanvasRenderingContext2D; frames: string[] }[] = [];
  for (const creature of CREATURES) {
    const canvas = document.createElement('canvas');
    canvas.width = 15;
    canvas.height = 15;
    canvas.className = 'welcome-creature';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    canvases.push({ ctx, frames: creature.frames });
  }
  let frame = 0;
  let lastSwap = 0;
  function tick(ts: number) {
    if (!container.isConnected) return;
    if (ts - lastSwap > 800) {
      frame = frame === 0 ? 1 : 0;
      lastSwap = ts;
      for (const c of canvases) {
        const src = c.frames[frame % c.frames.length];
        const img = imageCache.get(src);
        if (img) {
          c.ctx.clearRect(0, 0, 15, 15);
          c.ctx.drawImage(img, 0, 0, 15, 15);
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- Agent grid ---

// Build the per-frame chrome buttons (spawn-sibling / remove-worktree).
// Called from inside renderAgentGrid for each agent frame. Buttons are
// hover-revealed via CSS — opacity 0 at rest, brighter on frame hover,
// full on self-hover. They get inserted into `chromeEl` (a flex strip)
// so the final visual order is
// [⎘ spawn] [× remove] [> term] [x close] — close stays anchored at the
// frame's far right corner regardless of which conditional buttons are
// present.
function buildFrameChrome(agent: Agent, chromeEl: HTMLElement): void {
  // Derive the repo cwd and worktree name from agent.cwd. Two cases
  // produce a worktree agent:
  //  1. Scanner's `AssignWorktrees` heuristic — runs when 2+ agents
  //     share a main-repo cwd. Here `agent.cwd` is the main repo and
  //     `agent.worktree` carries the worktree name.
  //  2. A sibling spawned by this feature — Claude's session file
  //     records the worktree directory as the cwd, so `agent.cwd`
  //     contains `/.claude/worktrees/<name>` and `agent.worktree` is
  //     usually empty (no sibling to pair with).
  // Splitting on the well-known segment handles both: if it's present
  // anywhere in the cwd, we can recover both the main repo path and
  // the worktree name. If absent, fall back to the scanner-provided
  // fields (main-repo agent, or the heuristic-tagged case).
  const WORKTREE_SEG = '/.claude/worktrees/';
  const segIdx = agent.cwd.indexOf(WORKTREE_SEG);
  const inWorktree = segIdx > 0;
  const repoCwd = inWorktree ? agent.cwd.substring(0, segIdx) : agent.cwd;
  const worktreeName = inWorktree
    ? agent.cwd.substring(segIdx + WORKTREE_SEG.length).split('/')[0]
    : agent.worktree;

  // Spawn-sibling: shown for any agent whose cwd is a git repo. We use
  // `agent.branch` as the heuristic — the scanner only sets `branch`
  // when the cwd has a git repo, so a non-empty value means "git repo".
  if (agent.branch) {
    const spawnBtn = document.createElement('span');
    spawnBtn.className = 'frame-spawn-sibling';
    spawnBtn.title = 'spawn a sibling agent in a new worktree of this repo';
    spawnBtn.textContent = '⎘';
    spawnBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Open in `loading` state immediately so the user sees feedback
      // while we wait for `list_worktrees` to come back, then stash the
      // handle so the response branch in `conn.onMessage` can populate
      // the existing-worktrees list once it arrives.
      const handle = openWorktreeSpawn(spawnBtn, (req, hdl) => {
        hdl.setBusy(true);
        // Always pass the MAIN repo cwd, even if this frame is itself
        // a worktree agent — otherwise the new worktree would nest
        // inside the existing one. Inherit `spawnSkipPermissions`
        // (the same "yolo" flag the main "+ new agent" button uses,
        // default true) so sibling agents don't fire a permission
        // picker on every routine git/file tool call — they work on
        // the same repo and the user already trusted the main one.
        conn.spawnWorktreeAgent(repoCwd, req.name, false, spawnSkipPermissions);
      }, {
        loading: true,
        onResume: (name) => {
          // Resume == launch a fresh tmux+claude in an already-on-disk
          // worktree path. spawnAgentPath already does exactly that —
          // no need for a separate WS verb.
          const wtPath = `${repoCwd}/.claude/worktrees/${name}`;
          conn.spawnAgentPath(wtPath, false, spawnSkipPermissions);
        },
        onDelete: (name) => {
          // The popover already confirmed with the user. Re-register
          // the handle so the refresh we request from the response
          // handler can repopulate the (still open) popover.
          pendingWorktreeSpawnHandles.set(repoCwd, handle);
          pendingPopoverDeleteRepo = repoCwd;
          conn.removeWorktree(`${repoCwd}/.claude/worktrees/${name}`);
        },
      });
      pendingWorktreeSpawnHandles.set(repoCwd, handle);
      conn.listWorktrees(repoCwd);
    });
    // Prepend so this lands at the LEFT end of the chrome strip,
    // with term / close anchored at the right.
    chromeEl.insertBefore(spawnBtn, chromeEl.firstChild);
  }

  // Interrupt: send an Escape keypress to the agent's tmux pane — same
  // effect as pressing ESC inside Claude Code: cancel the in-flight
  // thought without killing the process. Sits to the LEFT of the spawn
  // button so the strip reads [⏹ stop] [⎘ spawn] [× remove] [> term]
  // [x close]. PID-based, so we only render it when the agent has a
  // running PID (skip stale done frames).
  if (agent.pid && agent.status !== 'done') {
    const stopBtn = document.createElement('span');
    stopBtn.className = 'frame-interrupt';
    stopBtn.title = 'interrupt agent (ESC) — cancel current thought';
    stopBtn.textContent = '⏹';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      conn.interruptAgent(agent.pid);
    });
    chromeEl.insertBefore(stopBtn, chromeEl.firstChild);
  }

  // Remove-worktree: only on stale (status=done) worktree frames.
  // Uses the path derived above so it works for both the scanner's
  // heuristic-tagged case AND freshly-spawned siblings whose
  // `agent.worktree` is empty.
  if (worktreeName && agent.status === 'done') {
    const removeBtn = document.createElement('span');
    removeBtn.className = 'frame-remove-worktree';
    removeBtn.title = 'remove this worktree';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const confirmed = window.confirm(
        `Remove worktree "${worktreeName}"? This deletes the working directory.`,
      );
      if (!confirmed) return;
      const path = `${repoCwd}/.claude/worktrees/${worktreeName}`;
      conn.removeWorktree(path);
      // Removing the worktree agent also closes its chat panel (lane).
      removeLane(agent.cwd);
    });
    // Insert before the term button so the strip reads
    //   [⎘ spawn] [× remove] [> term] [x close]
    const termBtnEl = chromeEl.querySelector('.agent-term-btn');
    if (termBtnEl) chromeEl.insertBefore(removeBtn, termBtnEl);
    else chromeEl.appendChild(removeBtn);
  }
}

function renderAgentGrid(agents: Agent[]) {
  const grid = document.getElementById('agent-grid')!;
  const filtered = agents.filter(a => a.sessionId !== 'boss');
  const rawGroups = groupAgents(filtered);
  // Push in-lane agents to the LEFT of the dynamic grid (right after
  // the static Boss frame). That way Tab cycles through paneled
  // agents first — the ones the user is actively interleaving with —
  // before falling through to non-paneled agents and back to the
  // global input. Stable within each partition so the order doesn't
  // jitter on every state tick.
  // In-lane agents go first, ordered to match the lane order on
  // screen. Non-lane agents follow in their original order. When the
  // user swaps two lane tabs, the grid frames automatically follow
  // because we re-read laneOrder() on every render tick.
  const laneCwdOrder = laneOrder().filter((c): c is string => c !== null);
  const inLaneGroups = rawGroups
    .filter((g) => hasLane(g.cwd))
    .sort((a, b) => laneCwdOrder.indexOf(a.cwd) - laneCwdOrder.indexOf(b.cwd));
  const nonLaneGroups = rawGroups.filter((g) => !hasLane(g.cwd));
  const groups = [...inLaneGroups, ...nonLaneGroups];
  const currentKeys = new Set(groups.map(g => g.key));

  for (const [key, frame] of agentFrames) {
    if (!currentKeys.has(key)) {
      cancelAnimationFrame(frame.animTimer);
      frame.element.remove();
      agentFrames.delete(key);
    }
  }

  let welcome = grid.querySelector('.welcome-panel') as HTMLElement | null;
  if (groups.length === 0) {
    if (!welcome) {
      welcome = document.createElement('div');
      welcome.className = 'welcome-panel';
      welcome.innerHTML = `
        <div class="welcome-sprites"></div>
        <div class="welcome-title">welcome to bitwise</div>
        <div class="welcome-body">bitwise watches your claude code agents.<br>start a session in any repo and it'll appear here.</div>
        <div class="welcome-tips">
          <span>tab &mdash; cycle agents</span>
          <span>click &mdash; select &amp; chat</span>
          <span>/help &mdash; commands</span>
        </div>
      `;
      grid.appendChild(welcome);
      animateWelcomeSprites(welcome.querySelector('.welcome-sprites')!);
    }
    return;
  }
  if (welcome) welcome.remove();

  for (const group of groups) {
    const key = group.key;
    let frame = agentFrames.get(key);

    if (!frame) {
      const el = document.createElement('div');
      el.className = 'agent-frame';
      // Allow this frame to be dragged into the chat-lanes container
      // to open a dedicated lane for that agent. Use agent.cwd (not
      // the worktree-decorated group key) so the lane matches the
      // cwd that arrives on chat_stream events and the lane working
      // check (state.find by cwd).
      attachLaneDragSource(el, group.cwd);

      const canvas = document.createElement('canvas');
      canvas.width = 15;
      canvas.height = 15;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;

      const nameEl = document.createElement('div');
      nameEl.className = 'creature-name';

      const countEl = document.createElement('div');
      countEl.className = 'agent-count-badge';

      const levelEl = document.createElement('div');
      levelEl.className = 'agent-level';

      const xpBarEl = document.createElement('div');
      xpBarEl.className = 'xp-bar';

      const statusEl = document.createElement('div');
      statusEl.className = 'agent-status';

      const statsEl = document.createElement('div');
      statsEl.className = 'agent-stats';

      const projectEl = document.createElement('div');
      projectEl.className = 'agent-project';

      const firstAgent = group.agents[0];
      nameEl.addEventListener('click', () => {
        window.location.href = `/profile.html?cwd=${encodeURIComponent(key)}&sid=${encodeURIComponent(firstAgent.sessionId)}`;
      });

      const inner = document.createElement('div');
      inner.className = 'agent-frame-inner';

      const spriteWrap = document.createElement('div');
      spriteWrap.className = 'sprite-wrap';
      spriteWrap.appendChild(canvas);

      const mainCol = document.createElement('div');
      mainCol.className = 'frame-main';
      mainCol.appendChild(spriteWrap);
      mainCol.appendChild(countEl);
      mainCol.appendChild(nameEl);
      mainCol.appendChild(levelEl);
      mainCol.appendChild(xpBarEl);
      mainCol.appendChild(statusEl);
      mainCol.appendChild(statsEl);
      mainCol.appendChild(projectEl);

      const subsCol = document.createElement('div');
      subsCol.className = 'frame-subs';

      inner.appendChild(mainCol);
      inner.appendChild(subsCol);

      const footerEl = document.createElement('div');
      footerEl.className = 'frame-footer';
      footerEl.innerHTML = '<div class="footer-fill"></div>';

      const closeBtn = document.createElement('div');
      closeBtn.className = 'agent-close-btn';
      closeBtn.textContent = 'x';
      closeBtn.title = 'stop agent';
      let closeConfirmTimer = 0;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const firstAgent = group.agents[0];
        if (!firstAgent) return;
        if (closeBtn.classList.contains('confirm')) {
          clearTimeout(closeConfirmTimer);
          closeBtn.classList.remove('confirm');
          closeBtn.textContent = 'x';
          conn.stopAgent(firstAgent.pid);
          // Closing the agent also closes its chat panel (lane) — no-ops if
          // it never had one. removeLane refuses the general lane.
          removeLane(group.key);
        } else {
          closeBtn.classList.add('confirm');
          closeBtn.textContent = '?';
          closeConfirmTimer = window.setTimeout(() => {
            closeBtn.classList.remove('confirm');
            closeBtn.textContent = 'x';
          }, 3000);
        }
      });

      const termBtn = document.createElement('div');
      termBtn.className = 'agent-term-btn';
      termBtn.textContent = '>';
      termBtn.title = 'open terminal';
      termBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const firstAgent = group.agents[0];
        if (firstAgent) {
          selectedCwd = group.key;
          selectedSessionId = firstAgent.sessionId;
          selectedPid = firstAgent.pid;
          updateChatTarget();
          updateFrameSelection();
          conn.attachAgent(firstAgent.pid);
        }
      });

      // "Awaiting your input" affordance: when the agent's tmux pane
      // is showing a Claude Code picker, the whole frame gets the
      // .awaiting-choice class and the sprite tints gold + pulses.
      // No overlaid badge — that was covering the creature. The
      // sprite-wrap itself becomes the click target in that state
      // (CSS shows pointer cursor) and jumps to the lane.
      spriteWrap.addEventListener('click', (e) => {
        if (!el.classList.contains('awaiting-choice')) return;
        e.stopPropagation();
        if (!hasLane(group.cwd)) addLane(group.cwd);
        focusLaneInput(group.cwd);
      });

      // All top-right chrome buttons (close, term, plus the optional
      // spawn-sibling / remove-worktree from `buildFrameChrome`) live
      // inside a single flex strip so they sit side-by-side without
      // gaps when a conditional button is hidden. Final visual order:
      //   [⎘ spawn] [× remove] [> term] [x close]
      const chromeWrap = document.createElement('div');
      chromeWrap.className = 'frame-chrome';
      chromeWrap.appendChild(termBtn);
      chromeWrap.appendChild(closeBtn);

      el.appendChild(chromeWrap);
      el.appendChild(inner);
      el.appendChild(footerEl);
      // Per-frame chrome buttons (spawn-sibling, remove-worktree).
      // Renders only when relevant: spawn requires the cwd to be a git
      // repo; remove appears only on stale worktree frames. Driven by
      // the agent's own metadata so no per-frame state is held here.
      // `firstAgent` is declared earlier in this scope.
      if (firstAgent) buildFrameChrome(firstAgent, chromeWrap);
      grid.appendChild(el);

      // Single source of truth shared with the chat badge + active bar: an
      // assigned creature, or a random one persisted on first creation.
      const creatureIndex = resolveCreatureIndex(key, CREATURES.length);

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('creature-name') || target.classList.contains('change-creature')) return;

        if (selectedCwd === group.key) {
          selectedCwd = null;
          selectedSessionId = null;
          selectedPid = null;
        } else {
          selectedCwd = group.key;
          const agent = group.agents[0];
          selectedSessionId = agent.sessionId;
          selectedPid = agent.pid;
        }
        updateChatTarget();
        updateFrameSelection();
      });

      frame = { element: el, canvas, ctx, creatureIndex, currentFrame: 0, animTimer: 0 };
      agentFrames.set(key, frame);

      startAnimation(frame);
    }

    const savedName = loadAgentName(key);
    const nameEl = frame.element.querySelector('.creature-name')!;
    const countEl = frame.element.querySelector('.agent-count-badge')! as HTMLElement;
    const levelEl = frame.element.querySelector('.agent-level')!;
    const statusEl = frame.element.querySelector('.agent-status')!;
    const statsEl = frame.element.querySelector('.agent-stats')!;
    const projectEl = frame.element.querySelector('.agent-project')!;

    const displayName = savedName || shortenPath(group.cwd);
    nameEl.textContent = displayName;

    const countParts: string[] = [];
    if (group.count > 1) countParts.push(`x${group.count}`);
    if (group.activeSubs > 0) countParts.push(`+${group.activeSubs} subs`);
    if (countParts.length > 0) {
      countEl.textContent = countParts.join(' ');
      countEl.style.display = '';
    } else {
      countEl.style.display = 'none';
    }

    const xp = group.totalCommits + getBonusXP(key);
    const lvl = getLevel(xp);
    // Just the level number — the XP/needed numbers were noisy in
    // the frame; the bar already conveys progress visually.
    levelEl.textContent = `lv.${lvl.level}`;

    const lvlColor = levelColor(lvl.level);
    (levelEl as HTMLElement).style.color = lvlColor;

    const totalBlocks = 10;
    const filledBlocks = Math.floor(lvl.progress * totalBlocks);
    const xpBar = frame.element.querySelector('.xp-bar')!;
    xpBar.innerHTML = '';
    for (let i = 0; i < totalBlocks; i++) {
      const block = document.createElement('span');
      block.className = i < filledBlocks ? 'xp-block filled' : 'xp-block empty';
      if (i < filledBlocks) (block as HTMLElement).style.background = lvlColor;
      xpBar.appendChild(block);
    }

    statusEl.textContent = '';

    // Frame body shows just the XP bar + branch — commits / pushes /
    // merges and the folder path were removed to keep the frame
    // focused on the parts the user actually scans for. Branch is
    // populated below; clear stats + project text.
    statsEl.textContent = '';
    projectEl.textContent = '';

    // Branch line — always rendered now, with "No branch" as the
    // empty-state fallback so frames stay the same height regardless
    // of git state. Created lazily once and reused on subsequent
    // renders to keep DOM churn minimal.
    let branchEl = frame.element.querySelector('.agent-branch') as HTMLElement | null;
    if (!branchEl) {
      branchEl = document.createElement('div');
      branchEl.className = 'agent-branch';
      projectEl.after(branchEl);
    }
    branchEl.textContent = group.branch ? `⌥ ${group.branch}` : 'No branch';
    branchEl.classList.toggle('agent-branch-empty', !group.branch);

    // Picker / permission prompt indicator. Roll up to the group:
    // any agent in the group with a live picker tints the sprite
    // gold and lights the footer accent.
    {
      const awaiting = group.agents.some((a) => a.awaitingChoice);
      frame.element.classList.toggle('awaiting-choice', awaiting);
    }

    // Active subagents
    const subsCol = frame.element.querySelector('.frame-subs')!;
    const allSubs = group.agents.flatMap(a => a.subagents || []);
    const activeSubs = allSubs.filter(s => s.active);

    if (activeSubs.length > 0) {
      subsCol.innerHTML = '';
      (subsCol as HTMLElement).style.display = '';
      for (const sub of activeSubs) {
        const subEl = document.createElement('div');
        subEl.className = 'sub-agent';
        const spinner = document.createElement('span');
        spinner.className = 'sub-spinner';
        const subLabel = document.createElement('div');
        subLabel.className = 'sub-label';
        subLabel.textContent = sub.description.length > 22 ? sub.description.slice(0, 20) + '..' : sub.description;
        subEl.appendChild(spinner);
        subEl.appendChild(subLabel);
        subsCol.appendChild(subEl);
      }
    } else {
      (subsCol as HTMLElement).style.display = 'none';
      subsCol.innerHTML = '';
    }

    const isFaded = soloMode && selectedCwd && group.key !== selectedCwd;
    // hasLane uses agent.cwd (no worktree decoration); same for the
    // color lookup so the lane tab + grid badge share a tint.
    const inLane = hasLane(group.cwd);
    const inCollapsedLane = inLane && isLaneCollapsed(group.cwd);
    // When at least one agent lane is open, Tab cycles only between
    // lane-attached panels — so fade the non-attached agents in the
    // grid to make the cycle visually match the user's mental model.
    const cycleSkipped = hasAnyAgentLane() && !inLane;
    frame.element.className = `agent-frame ${group.status || 'idle'}${group.key === selectedCwd ? ' selected' : ''}${isFaded ? ' solo-faded' : ''}${inLane ? ' in-lane' : ''}${inCollapsedLane ? ' in-collapsed-lane' : ''}${cycleSkipped ? ' cycle-skipped' : ''}`;
    if (inLane) {
      const hue = agentColor(group.cwd);
      frame.element.style.borderColor = hue;
      frame.element.style.setProperty('--agent-hue', hue);
    } else {
      frame.element.style.borderColor = '';
      frame.element.style.removeProperty('--agent-hue');
    }
  }

  for (const group of groups) {
    const frame = agentFrames.get(group.key);
    if (frame) grid.appendChild(frame.element);
  }

  // Recompute cols × rows now that the frame count is current.
  // Without this the layout would lag one tick behind on count
  // changes (waiting for the ResizeObserver to fire on the next
  // size change).
  applyAgentGridLayout();
}

function startAnimation(frame: AgentFrame) {
  const creature = CREATURES[frame.creatureIndex];
  let lastSwap = 0;

  function animate(time: number) {
    if (time - lastSwap > 800) {
      frame.currentFrame = (frame.currentFrame + 1) % 2;
      lastSwap = time;

      const src = creature.frames[frame.currentFrame];
      const img = imageCache.get(src);
      if (img) {
        frame.ctx.clearRect(0, 0, 15, 15);
        frame.ctx.drawImage(img, 0, 0, 15, 15);
      }
    }
    frame.animTimer = requestAnimationFrame(animate);
  }

  const img = imageCache.get(creature.frames[0]);
  if (img) {
    frame.ctx.clearRect(0, 0, 15, 15);
    frame.ctx.drawImage(img, 0, 0, 15, 15);
  }
  frame.animTimer = requestAnimationFrame(animate);
}

// --- Global keyboard shortcuts ---

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.code === 'Enter') && document.activeElement !== document.getElementById('chat-input')) {
    // Lane inputs run their own Enter / Shift+Enter handling (send vs.
    // newline). Bail out so this fallback doesn't preventDefault the
    // newline out of a lane input.
    const active = document.activeElement as HTMLElement | null;
    if (active?.classList?.contains('lane-input')) return;
    appendDebugLog(`[doc-enter] focus was on ${(active)?.tagName || 'null'} → refocusing chat-input`);
    e.preventDefault();
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.focus();
    // If a modal or dropdown is open, the user is interacting with it, not
    // submitting a chat message. Skip send. Otherwise, if content is already
    // in the input (e.g. Wispr/dictation inserted via accessibility API
    // while focus was elsewhere), fire the send now so the user doesn't
    // have to press Enter a second time.
    const modalOpen = !!document.querySelector('.picker-overlay, .settings-overlay, .image-overlay, #spawn-dropdown');
    if (!e.shiftKey && !modalOpen && (input.value.trim() || hasImages())) {
      appendDebugLog(`[doc-enter] input has content and no modal open → triggering send`);
      if (trySendFromChatInput('doc-keydown')) {
        // trySendFromChatInput returns true when it handled the send — nothing
        // else to do; the default action was already preventDefault'd above.
      }
    }
  }
});

// --- Commands ---

interface Command {
  name: string;
  description: string;
  execute: (args: string) => void;
}

const COMMANDS: Command[] = [
  { name: '/editor', description: 'open sprite editor', execute: () => { window.location.href = '/editor.html'; } },
  { name: '/exit', description: 'close the app', execute: () => window.close() },
  { name: '/status', description: 'show agent status', execute: () => conn.sendCommand('status') },
  { name: '/help', description: 'list commands', execute: () => showResponse(COMMANDS.map(c => `${c.name} — ${c.description}`).join('  |  ')) },
  { name: '/clear', description: 'clear chat', execute: () => {
    // Full reset: wipe in-memory history, persisted history, and any
    // pending render flag. Then push a single confirmation entry so the
    // user gets visible feedback (the previous version wiped silently
    // and looked glitched if the panel was blank to begin with).
    snapshotChatForUndo();
    chatHistory.length = 0;
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* ignore */ }
    if (chatPersistTimer !== null) {
      clearTimeout(chatPersistTimer);
      chatPersistTimer = null;
    }
    chatRenderQueued = false;
    const el = document.getElementById('chat-response');
    if (el) el.innerHTML = '';
    renderChatHistory();
    appendChatMessage('system', 'chat cleared (Cmd+Z to undo)');
  } },
  { name: '/debug', description: 'toggle debug log', execute: () => toggleDebugPanel() },
  { name: '/xp', description: 'give xp: /xp <name> <amount>', execute: (args: string) => {
    const parts = args.split(' ');
    const name = parts[0];
    const amount = parseInt(parts[1]) || 0;
    if (!name || !amount) { showResponse('usage: /xp <name> <amount>'); return; }
    const agents = state.getAgents();
    let cwd = '';
    for (const a of agents) {
      const profile = getProfile(a.cwd);
      const agentName = profile.name || shortenPath(a.cwd);
      if (agentName.toLowerCase() === name.toLowerCase()) { cwd = a.cwd; break; }
    }
    if (!cwd) { showResponse(`agent "${name}" not found`); return; }
    addBonusXP(cwd, amount);
    showResponse(`+${amount} xp to ${name}`);
    renderAgentGrid(state.getAgents());
  }},
  { name: '/utku', description: 'summon the office critic', execute: () => spawnUtku() },
  { name: '/utku-auto', description: 'toggle random utku heckling on prompts', execute: () => toggleUtkuAuto() },
  { name: '/pr-review', description: 'ask the agent to check PR comments with radical honesty', execute: () => sendPrReviewPrompt() },
  { name: '/rebuild', description: 'rebuild + relaunch bitwise.app (dev)', execute: () => runRebuild() },
];

async function runRebuild() {
  appendChatMessage('system', 'rebuilding bitwise.app — the window will close and reopen…');
  try {
    const resp = await fetch('http://localhost:3333/api/rebuild', { method: 'POST' });
    if (!resp.ok) {
      const body = await resp.text();
      appendChatMessage('system', `rebuild failed (${resp.status}): ${body.trim()}`);
    }
  } catch (err) {
    appendChatMessage('system', `rebuild failed: ${(err as Error).message}`);
  }
}

// --- Utku easter egg ---

const UTKU_SPRITE = [
  '......###......',
  '.....#####.....',
  '....#######....',
  '....##.#.##....',
  '....#.#.#.#....',
  '....#######....',
  '....##.#.##....',
  '....#######....',
  '.....#####.....',
  '.#####...#####.',
  '##.##.....##.##',
  '.....#...#.....',
  '.....#...#.....',
  '....##...##....',
  '....##...##....',
];

const UTKU_PHRASES = [
  'this is wrong',
];

let lastUtkuPhrase: string | null = null;
function pickUtkuPhrase(): string {
  if (UTKU_PHRASES.length <= 1) return UTKU_PHRASES[0];
  const pool = UTKU_PHRASES.filter(p => p !== lastUtkuPhrase);
  const next = pool[Math.floor(Math.random() * pool.length)];
  lastUtkuPhrase = next;
  return next;
}

const PR_REVIEW_PROMPT =
  'Please check the PR for any comments & assess their validity radically honestly';

function sendPrReviewPrompt() {
  if (!selectedCwd || !selectedSessionId || selectedPid === null) {
    showResponse('select an agent first');
    return;
  }
  if (!conn.isConnected()) {
    flashDisconnectedWarning();
    return;
  }
  const agentName = displayName(selectedCwd);
  if (!conn.sendChat(selectedCwd, selectedSessionId, selectedPid, PR_REVIEW_PROMPT)) {
    flashDisconnectedWarning();
    return;
  }
  rememberInInputHistory(PR_REVIEW_PROMPT);
  appendChatMessage('user', PR_REVIEW_PROMPT, undefined, agentName);
  maybeSpawnUtkuAuto();
}

function toggleUtkuAuto() {
  utkuAutoMode = !utkuAutoMode;
  localStorage.setItem('utkuAutoMode', utkuAutoMode ? '1' : '0');
  const pct = Math.round(UTKU_AUTO_CHANCE * 100);
  showResponse(utkuAutoMode ? `utku auto-heckle: ON (${pct}% per prompt)` : 'utku auto-heckle: OFF');
}

function maybeSpawnUtkuAuto() {
  if (!utkuAutoMode) return;
  if (Math.random() < UTKU_AUTO_CHANCE) spawnUtku();
}

function spawnUtku() {
  document.querySelectorAll('.utku-summon').forEach(el => el.remove());

  const container = document.createElement('div');
  container.className = 'utku-summon';

  const canvas = document.createElement('canvas');
  canvas.width = 15;
  canvas.height = 15;
  canvas.className = 'utku-sprite';
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#eae5ce';
  for (let y = 0; y < UTKU_SPRITE.length; y++) {
    for (let x = 0; x < UTKU_SPRITE[y].length; x++) {
      if (UTKU_SPRITE[y][x] === '#') ctx.fillRect(x, y, 1, 1);
    }
  }

  const bubble = document.createElement('div');
  bubble.className = 'utku-bubble';
  bubble.textContent = pickUtkuPhrase();

  container.appendChild(bubble);
  container.appendChild(canvas);
  document.body.appendChild(container);

  // Anchor above the chat input, which can be either at the bottom (default)
  // or near the top when avatars are docked to the bottom.
  const chatBar = document.getElementById('chat-bar');
  if (chatBar) {
    const rect = chatBar.getBoundingClientRect();
    const gap = 12;
    container.style.bottom = `${Math.max(8, window.innerHeight - rect.top + gap)}px`;
  }

  requestAnimationFrame(() => container.classList.add('utku-in'));

  setTimeout(() => {
    container.classList.remove('utku-in');
    container.classList.add('utku-out');
    setTimeout(() => container.remove(), 400);
  }, 5000);
}

// Passthrough slash commands — sent as-is to the selected agent's chat.
const PASSTHROUGH_COMMANDS: { name: string; description: string }[] = [
  { name: '/brainstorming', description: 'start brainstorm session' },
  { name: '/btw', description: 'by the way...' },
  { name: '/compact', description: 'compact conversation' },
  { name: '/effort', description: 'set effort: low | medium | high | auto' },
  { name: '/resume', description: 'resume last session' },
  { name: '/model', description: 'switch model' },
  { name: '/review', description: 'code review' },
  { name: '/plan', description: 'plan mode' },
  { name: '/pr-review-handler', description: 'handle PR review feedback' },
];

// --- Autocomplete ---

let autocompleteIndex = -1;
let autocompleteMatches: string[] = [];
const autocompleteEl = document.createElement('div');
autocompleteEl.id = 'autocomplete';
document.getElementById('chat-bar')!.appendChild(autocompleteEl);

function updateAutocomplete(value: string) {
  if (!value.startsWith('/') || value.includes(' ')) {
    autocompleteEl.style.display = 'none';
    autocompleteMatches = [];
    autocompleteIndex = -1;
    return;
  }

  const allCommands: { name: string; description: string }[] = [
    ...COMMANDS.map(c => ({ name: c.name, description: c.description })),
    ...PASSTHROUGH_COMMANDS,
  ];
  const matched = allCommands.filter(c => c.name.startsWith(value));
  autocompleteMatches = matched.map(c => c.name);

  if (autocompleteMatches.length === 0 || (autocompleteMatches.length === 1 && autocompleteMatches[0] === value)) {
    autocompleteEl.style.display = 'none';
    autocompleteIndex = -1;
    return;
  }

  autocompleteIndex = -1;
  autocompleteEl.style.display = 'flex';
  autocompleteEl.innerHTML = matched
    .map((cmd, i) => `<span class="ac-item" data-index="${i}">${cmd.name} <span class="ac-desc">${cmd.description}</span></span>`)
    .join('');
}

function applyAutocomplete(chatInput: HTMLTextAreaElement) {
  if (autocompleteMatches.length > 0) {
    const idx = autocompleteIndex >= 0 ? autocompleteIndex : 0;
    chatInput.value = autocompleteMatches[idx] + ' ';
    autocompleteEl.style.display = 'none';
    autocompleteMatches = [];
    autocompleteIndex = -1;
  }
}

function highlightAutocomplete() {
  autocompleteEl.querySelectorAll('.ac-item').forEach((el, i) => {
    (el as HTMLElement).classList.toggle('ac-active', i === autocompleteIndex);
  });
}

// --- Chat input ---

const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;

function autoResizeInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
  chatInput.style.overflowY = chatInput.scrollHeight > 200 ? 'auto' : 'hidden';
}

chatInput.addEventListener('input', (e) => {
  const ie = e as InputEvent;
  // Only log input events with unusual inputTypes; plain typing spams the log.
  if (ie.inputType && ie.inputType !== 'insertText' && ie.inputType !== 'deleteContentBackward') {
    appendDebugLog(`[input] inputType=${ie.inputType} data=${JSON.stringify(ie.data ?? null)} valueLen=${chatInput.value.length}`);
  }
  updateAutocomplete(chatInput.value);
  autoResizeInput();
});

// Low-level tracing for every keydown on the chat input. Plain printable keys
// spam too much, so only log potentially-interesting events: Enter in any
// form, anything non-printable, anything with a modifier, IME composition,
// and anything where the target isn't who we expect.
chatInput.addEventListener('keydown', (e) => {
  const isEnterish = e.key === 'Enter' || e.code === 'Enter' || e.keyCode === 13 || e.keyCode === 229 || e.key === '\n' || e.key === '\r';
  const hasMod = e.altKey || e.metaKey || e.ctrlKey;
  const nonPrintable = e.key.length > 1;
  if (isEnterish || hasMod || nonPrintable || e.isComposing) {
    appendDebugLog(`[chat-kd] key=${JSON.stringify(e.key)} code=${e.code} keyCode=${e.keyCode} shift=${e.shiftKey} alt=${e.altKey} meta=${e.metaKey} ctrl=${e.ctrlKey} compose=${e.isComposing} valueLen=${chatInput.value.length} activeEq=${document.activeElement === chatInput}`);
  }
}, true);

// beforeinput fires *before* the textarea mutates; trace every line-break-ish
// inputType so we can tell whether Wispr and friends deliver their final Enter
// as insertLineBreak, insertParagraph, or something else entirely.
chatInput.addEventListener('beforeinput', (e) => {
  const ie = e as InputEvent;
  if (ie.inputType === 'insertLineBreak' || ie.inputType === 'insertParagraph' ||
      (ie.inputType === 'insertText' && (ie.data ?? '').includes('\n')) ||
      ie.inputType === 'insertReplacementText') {
    appendDebugLog(`[chat-bi] inputType=${ie.inputType} data=${JSON.stringify(ie.data ?? null)} valueLen=${chatInput.value.length} activeEq=${document.activeElement === chatInput}`);
  }
}, true);

chatInput.addEventListener('keydown', (e) => {
  // Tab always cycles agents — except when a slash-command autocomplete menu is
  // showing, in which case Tab completes the highlighted suggestion.
  if (e.key === 'Tab') {
    e.preventDefault();
    if (autocompleteMatches.length > 0) {
      applyAutocomplete(chatInput);
      return;
    }
    cycleAllFocus(e.shiftKey);
    return;
  }

  // Arrow keys for autocomplete selection
  if (autocompleteMatches.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteIndex = Math.min(autocompleteIndex + 1, autocompleteMatches.length - 1);
      highlightAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteIndex = Math.max(autocompleteIndex - 1, 0);
      highlightAutocomplete();
      return;
    }
  }

  // Arrow up/down = input history (like a terminal)
  if (e.key === 'ArrowUp' && autocompleteMatches.length === 0) {
    e.preventDefault();
    if (inputHistory.length === 0) return;
    if (inputHistoryIndex === -1) {
      inputHistorySaved = chatInput.value;
      inputHistoryIndex = inputHistory.length - 1;
    } else if (inputHistoryIndex > 0) {
      inputHistoryIndex--;
    }
    chatInput.value = inputHistory[inputHistoryIndex];
    return;
  }
  if (e.key === 'ArrowDown' && autocompleteMatches.length === 0) {
    e.preventDefault();
    if (inputHistoryIndex === -1) return;
    if (inputHistoryIndex < inputHistory.length - 1) {
      inputHistoryIndex++;
      chatInput.value = inputHistory[inputHistoryIndex];
    } else {
      inputHistoryIndex = -1;
      chatInput.value = inputHistorySaved;
    }
    return;
  }

  // Escape = cancel boss → interrupt selected agent → close
  // autocomplete / clear input. Priority order matters: if the boss
  // is mid-stream we cancel first; otherwise if the user has an
  // agent selected, ESC interrupts that agent (sends Escape to its
  // tmux pane — same as pressing ESC inside Claude Code) and falls
  // back to boss. This makes the global cancel feel coherent: ESC
  // always interrupts "the thing that would receive my next
  // message", whether that's boss or an agent. Note: this used to
  // call stopAgent, which kills the tmux session — wrong shape;
  // interruptAgent leaves the agent alive and only cancels the
  // current thought.
  if (e.key === 'Escape') {
    if (bossThinking) {
      cancelBoss();
      return;
    }
    if (selectedPid !== null) {
      conn.interruptAgent(selectedPid);
      autocompleteEl.style.display = 'none';
      autocompleteMatches = [];
      return;
    }
    autocompleteEl.style.display = 'none';
    autocompleteMatches = [];
    chatInput.value = '';
    autoResizeInput();
    selectedCwd = null;
    selectedSessionId = null;
    selectedPid = null;
    updateChatTarget();
    updateFrameSelection();
    return;
  }

  // keyCode === 229 is the IME-active sentinel (Japanese, Korean, dictation
  // composition). Earlier we used `!e.isComposing` here, but WKWebView can
  // leave `isComposing` stale after programmatic value injection (Cmd+V via
  // the native paste bridge, Mac dictation), swallowing the next Enter as a
  // silent newline. keyCode is only 229 while composition is genuinely live.
  const isEnter = (e.key === 'Enter' || e.code === 'Enter') && e.keyCode !== 229;

  if (isEnter) {
    appendDebugLog(`[enter] key=${JSON.stringify(e.key)} code=${e.code} shift=${e.shiftKey} alt=${e.altKey} meta=${e.metaKey} ctrl=${e.ctrlKey} compose=${e.isComposing} keyCode=${e.keyCode} valueLen=${chatInput.value.length} trimLen=${chatInput.value.trim().length} hasImages=${hasImages()} ac.len=${autocompleteMatches.length} ac.idx=${autocompleteIndex} selCwd=${selectedCwd ? 'y' : 'n'} ws=${conn.isConnected() ? 'open' : 'closed'}`);
  }

  if (isEnter && e.shiftKey) {
    appendDebugLog('[enter] shift+enter → newline, no send');
    setTimeout(autoResizeInput, 0);
    return;
  }
  if (isEnter) {
    if (trySendFromChatInput('keydown')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  chatInput.focus();
});

// Belt-and-suspenders: catch missed Enter as a `beforeinput` line break. If
// keydown misses (stale `isComposing`, focus race after paste, WKWebView
// quirks on long text), the browser still fires `beforeinput` with inputType
// `insertLineBreak`/`insertParagraph` before mutating the textarea. We use
// that window to redirect a bare Enter into a send instead of a newline.
// Shift+Enter is tracked separately so we don't hijack intentional newlines.
chatInput.addEventListener('beforeinput', (e: Event) => {
  const ie = e as InputEvent;
  if (ie.inputType !== 'insertLineBreak' && ie.inputType !== 'insertParagraph') return;
  if (lastLineBreakShift) return;
  appendDebugLog(`[beforeinput] ${ie.inputType} intercepted — attempting send`);
  if (trySendFromChatInput('beforeinput')) e.preventDefault();
});

// Track whether the most recent keystroke that could produce a line break had
// shift held. Used by the beforeinput fallback to distinguish "send" from
// "intentional newline." Cleared on non-Enter keys so stale state can't leak.
let lastLineBreakShift = false;
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.code === 'Enter') {
    lastLineBreakShift = e.shiftKey;
  } else if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
    lastLineBreakShift = false;
  }
}, true);

function trySendFromChatInput(origin: 'keydown' | 'beforeinput' | 'doc-keydown'): boolean {
  if (!chatInput.value.trim() && !hasImages()) return false;
  appendDebugLog(`[send] origin=${origin} entering send branch`);
  if (autocompleteMatches.length > 0 && autocompleteIndex >= 0) {
    appendDebugLog('[send] autocomplete selected → applying instead of send');
    applyAutocomplete(chatInput);
    return true;
  }

  const cmd = chatInput.value.replace(/\[IMAGE\]/g, '').trim();

  const parts = cmd.split(' ');
  const cmdName = parts[0];
  const cmdArgs = parts.slice(1).join(' ');
  const localCmd = COMMANDS.find(c => c.name === cmdName);
  if (localCmd) {
    appendDebugLog(`[send] local command: ${cmdName}`);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    autocompleteEl.style.display = 'none';
    rememberInInputHistory(cmd);
    localCmd.execute(cmdArgs);
    return true;
  }

  if (!conn.isConnected()) {
    appendDebugLog('[send] !isConnected — flash, text stays');
    flashDisconnectedWarning();
    return true;
  }

  if (selectedCwd && selectedSessionId && selectedPid !== null) {
    const chatImages = hasImages() ? getImages().map(i => i.dataUrl) : undefined;
    const agentName = displayName(selectedCwd);
    let sent = false;
    if (hasImages()) {
      const imgs = getImages().map(i => i.base64);
      sent = conn.sendChatWithImages(selectedCwd, selectedSessionId, selectedPid, cmd, imgs);
    } else {
      sent = conn.sendChat(selectedCwd, selectedSessionId, selectedPid, cmd);
    }
    appendDebugLog(`[send] sendChat returned ${sent}`);
    if (!sent) {
      flashDisconnectedWarning();
      return true;
    }
    chatInput.value = '';
    chatInput.style.height = 'auto';
    autocompleteEl.style.display = 'none';
    rememberInInputHistory(cmd);
    appendChatMessage('user', cmd, chatImages, agentName);
    if (hasImages()) clearImages();
    maybeSpawnUtkuAuto();
    return true;
  }

  if (cmd.startsWith('/')) {
    const sent = conn.sendCommand(cmd);
    appendDebugLog(`[send] sendCommand returned ${sent}`);
    if (!sent) {
      flashDisconnectedWarning();
      return true;
    }
    chatInput.value = '';
    chatInput.style.height = 'auto';
    autocompleteEl.style.display = 'none';
    rememberInInputHistory(cmd);
    return true;
  }

  const bossImages = hasImages() ? getImages().map(i => i.dataUrl) : undefined;
  let bossSent = false;
  if (hasImages()) {
    const imgs = getImages().map(i => i.base64);
    bossSent = conn.sendBossMessage(cmd, imgs, bossThinkMode);
  } else {
    bossSent = conn.sendBossMessage(cmd, undefined, bossThinkMode);
  }
  appendDebugLog(`[send] sendBossMessage returned ${bossSent}`);
  if (!bossSent) {
    flashDisconnectedWarning();
    return true;
  }
  chatInput.value = '';
  chatInput.style.height = 'auto';
  autocompleteEl.style.display = 'none';
  rememberInInputHistory(cmd);
  appendChatMessage('user', cmd, bossImages, 'boss');
  pushChat({ role: 'boss', text: '', timestamp: Date.now(), streaming: true });
  bossThinking = true;
  updateBossStopButton();
  renderChatHistory();
  if (hasImages()) clearImages();
  maybeSpawnUtkuAuto();
  return true;
}

function rememberInInputHistory(cmd: string) {
  if (!cmd) return;
  inputHistory.push(cmd);
  if (inputHistory.length > MAX_INPUT_HISTORY) {
    inputHistory.splice(0, inputHistory.length - MAX_INPUT_HISTORY);
  }
  inputHistoryIndex = -1;
  inputHistorySaved = '';
}

function flashDisconnectedWarning() {
  chatInput.classList.remove('disconnected-flash');
  void chatInput.offsetWidth;
  chatInput.classList.add('disconnected-flash');
  setTimeout(() => chatInput.classList.remove('disconnected-flash'), 800);
}

function showResponse(text: string) {
  if (text) appendChatMessage('system', text);
}

// --- Chat font size ---
// Chat font size: Cmd+/- changes it (same var drives chat messages and the
// input together). Persisted across reloads.
const CHAT_FONT_MIN = 9;
const CHAT_FONT_MAX = 24;
let chatFontSize = parseInt(localStorage.getItem('chatFontSize') || '13', 10);
if (!Number.isFinite(chatFontSize)) chatFontSize = 13;
document.documentElement.style.setProperty('--chat-font-size', chatFontSize + 'px');

function setChatFontSize(next: number): void {
  chatFontSize = Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, next));
  document.documentElement.style.setProperty('--chat-font-size', chatFontSize + 'px');
  localStorage.setItem('chatFontSize', String(chatFontSize));
}

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    setChatFontSize(chatFontSize + 1);
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    setChatFontSize(chatFontSize - 1);
  } else if (e.key === '0') {
    e.preventDefault();
    setChatFontSize(13);
  }
});

// Cmd+Z / Ctrl+Z chat-history undo, Cmd+Shift+Z redo. Skipped when
// the focus is inside a textarea / input — there the browser's
// native textarea undo handles user typing, and intercepting Cmd+Z
// would steal it from anyone editing a long message. The undo
// applies to chatHistory snapshots taken before destructive ops
// (currently just `/clear`); sends are intentionally not snapshotted
// because the agent has already received them and rolling back
// the local view alone would desync UI from agent state.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
  e.preventDefault();
  if (e.shiftKey) {
    if (chatRedo()) appendChatMessage('system', 'redo');
  } else {
    if (chatUndo()) appendChatMessage('system', 'undo');
  }
});


// --- Settings ---

const settingsCanvas = document.getElementById('settings-icon') as HTMLCanvasElement;
if (settingsCanvas) {
  const sctx = settingsCanvas.getContext('2d')!;
  sctx.fillStyle = '#eae5ce';
  // Three-slider "settings" glyph — reads more clearly than a 9x9 cog,
  // which at this size tends to look like a key or a snowflake.
  const icon = [
    '.........',
    '#######..',
    '..##.....',
    '.........',
    '###.#####',
    '...##....',
    '.........',
    '####.####',
    '....##...',
  ];
  for (let y = 0; y < icon.length; y++) {
    for (let x = 0; x < icon[y].length; x++) {
      if (icon[y][x] === '#') sctx.fillRect(x, y, 1, 1);
    }
  }
}
document.getElementById('settings-btn')!.addEventListener('click', () => {
  openSettingsModal({
    terminalApp: currentSettings.terminalApp,
    avatarsHidden,
    bgColor,
    musicEnabled,
    musicStyle,
    musicDither,
    musicLyrics,
    musicSource,
    linearEnabled,
    linearApiKey: currentSettings.linearApiKey || '',
    lanesVertical,
    chatBubbles,
    bubbleUserColor,
    bubbleAgentColor,
    bubbleBossColor,
    agentsMinimal,
    notifyOnFinish,
    chatFont,
    isConnected: conn.isConnected(),
    musicPreview: { img: getCurrentArtwork(), render: ditherPreview },
  }, (key, value) => {
    if (key === 'resetAgentColors') {
      resetAgentColors();
      // Trigger a re-render so new colors apply immediately.
      renderAgentGrid(state.getAgents());
      return;
    }
    if (key === 'terminalApp' || key === 'linearApiKey') {
      // Server-persisted secrets live in ~/.cloovies/settings.json; after
      // writing the key, re-poll Linear so the panel recovers from its
      // "needs key" empty state without waiting for the 30s tick.
      conn.sendSettings('set', key, value);
      if (key === 'linearApiKey') setTimeout(refreshLinear, 200);
      return;
    }
    localStorage.setItem(key, value);
    if (key === 'musicStyle') { musicStyle = value; setMusicStyle(value); return; }
    if (key === 'musicDither') { musicDither = value; setMusicDither(value); return; }
    if (key === 'musicSource') { musicSource = value; setMusicSource(value); return; }
    const on = value === '1';
    if (key === 'bgColor') { bgColor = value; applyBgColor(); return; }
    if (key === 'bubbleUserColor')  { bubbleUserColor  = value; applyBubbleColors(); return; }
    if (key === 'bubbleAgentColor') { bubbleAgentColor = value; applyBubbleColors(); return; }
    if (key === 'bubbleBossColor')  { bubbleBossColor  = value; applyBubbleColors(); return; }
    if (key === 'agentsMinimal') { agentsMinimal = on; applyAgentsMinimal(); return; }
    if (key === 'chatFont') { chatFont = value; applyChatFont(value); return; }
    if (key === 'notifyOnFinish') {
      notifyOnFinish = on;
      localStorage.setItem('notifyOnFinish', on ? '1' : '0');
      // Pre-flight permission so the user gets the OS prompt at the
      // moment they enable the toggle, not later when an agent
      // happens to finish (which would feel out-of-context).
      if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      return;
    }
    if (key === 'avatarsHidden') { avatarsHidden = on; applyAvatarsHidden(); }
    else if (key === 'musicEnabled') { musicEnabled = on; setMusicEnabled(on); }
    else if (key === 'musicLyrics') { musicLyrics = on; setMusicLyrics(on); }
    else if (key === 'linearEnabled') { linearEnabled = on; setLinearEnabled(on); }
    else if (key === 'lanesVertical') { lanesVertical = on; applyLanesVertical(); }
    else if (key === 'chatBubbles') { chatBubbles = on; applyChatBubbles(); }
  });
});

// --- New agent dropdown ---

let dropdownOpen = false;
let spawnInTerminal = false;
let spawnSkipPermissions = true;

function closeDropdown() {
  const existing = document.getElementById('spawn-dropdown');
  if (existing) existing.remove();
  dropdownOpen = false;
}

function openDropdown() {
  closeDropdown();
  dropdownOpen = true;

  const dropdown = document.createElement('div');
  dropdown.id = 'spawn-dropdown';

  if (recentFolders.length > 0) {
    for (const folder of recentFolders.slice(0, 8)) {
      const item = document.createElement('div');
      item.className = 'spawn-dropdown-item';
      item.textContent = folder.split('/').filter(Boolean).pop() || folder;
      item.title = folder;
      item.addEventListener('click', () => {
        newAgentBtn.classList.add('spawning');
        conn.spawnAgentPath(folder, spawnInTerminal, spawnSkipPermissions);
      });
      dropdown.appendChild(item);
    }

    const sep = document.createElement('div');
    sep.className = 'spawn-dropdown-sep';
    dropdown.appendChild(sep);
  }

  const browse = document.createElement('div');
  browse.className = 'spawn-dropdown-item browse';
  browse.textContent = 'Browse...';
  browse.addEventListener('click', () => {
    newAgentBtn.classList.add('spawning');
    conn.spawnAgent(spawnInTerminal, spawnSkipPermissions);
  });
  dropdown.appendChild(browse);

  const sep2 = document.createElement('div');
  sep2.className = 'spawn-dropdown-sep';
  dropdown.appendChild(sep2);

  dropdown.appendChild(buildDropdownToggle('terminal', spawnInTerminal, v => spawnInTerminal = v));
  dropdown.appendChild(buildDropdownToggle('yolo', spawnSkipPermissions, v => spawnSkipPermissions = v));

  newAgentBtn.parentElement!.appendChild(dropdown);
}

function buildDropdownToggle(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spawn-dropdown-toggle';
  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  const btn = document.createElement('span');
  let value = initial;
  const render = () => {
    btn.textContent = value ? '●' : '○';
    btn.classList.toggle('active', value);
  };
  btn.className = 'spawn-toggle-btn';
  render();
  btn.addEventListener('click', () => {
    value = !value;
    onChange(value);
    render();
  });
  row.appendChild(labelEl);
  row.appendChild(btn);
  return row;
}

const newAgentBtn = document.getElementById('new-agent-btn')!;

newAgentBtn.addEventListener('click', () => {
  if (newAgentBtn.classList.contains('spawning')) return;
  if (dropdownOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
});

document.addEventListener('click', (e) => {
  if (dropdownOpen && !(e.target as Element).closest('#spawn-dropdown') && !(e.target as Element).closest('#new-agent-btn')) {
    closeDropdown();
  }
});

// --- Image Queue ---

initImageQueue(document.getElementById('image-queue')!, () => {
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
  if (hasImages() && selectedCwd) {
    chatInput.placeholder = 'add a message (optional)...';
  }
});

// Paste handler
document.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        addImage(reader.result as string);
        // Drop the [IMAGE] marker into whichever input is focused —
        // global #chat-input or any .lane-input — so the user sees
        // the image was captured for the message they're composing.
        const active = document.activeElement as HTMLTextAreaElement | null;
        const isTextarea = active && (active.id === 'chat-input' || active.classList?.contains('lane-input'));
        const input = isTextarea ? active : (document.getElementById('chat-input') as HTMLTextAreaElement | null);
        if (input) {
          const start = input.selectionStart;
          const end = input.selectionEnd;
          const marker = '[IMAGE]';
          input.value = input.value.substring(0, start) + marker + input.value.substring(end);
          input.selectionStart = input.selectionEnd = start + marker.length;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

// Drop handler
const appEl = document.getElementById('app')!;
appEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (selectedCwd) appEl.classList.add('drag-over');
});
appEl.addEventListener('dragleave', () => {
  appEl.classList.remove('drag-over');
});
appEl.addEventListener('drop', (e) => {
  e.preventDefault();
  appEl.classList.remove('drag-over');
  if (!selectedCwd) return;
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        addImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  }
});

// Bridge for native clipboard monitor
(window as any).onClipboardImage = (base64: string) => {
  addImageFromBase64(base64);
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  if (input) {
    const start = input.selectionStart;
    const marker = '[IMAGE]';
    input.value = input.value.substring(0, start) + marker + input.value.substring(input.selectionEnd);
    input.selectionStart = input.selectionEnd = start + marker.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

// --- Debug panel buttons ---

document.getElementById('debug-close')?.addEventListener('click', () => toggleDebugPanel());
document.getElementById('boss-stop')?.addEventListener('click', () => cancelBoss());

// --- Boot ---

async function init() {
  await Promise.all([loadAllProfiles(), loadCreatures()]);
  initBossSprite();
  initBossModeToggle();
  conn.connect();
}

init();
