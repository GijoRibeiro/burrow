import { Agent } from './types';

export type StateListener = (agents: Agent[]) => void;

export class State {
  private agents: Agent[] = [];
  private byId: Map<string, Agent> = new Map();
  private listeners: StateListener[] = [];
  private lastHash = '';

  update(agents: Agent[]): void {
    const hash = hashAgents(agents);
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    this.agents = agents;
    this.byId.clear();
    for (const a of agents) this.byId.set(a.sessionId, a);
    this.listeners.forEach((l) => l(this.agents));
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  getAgent(sessionId: string): Agent | undefined {
    return this.byId.get(sessionId);
  }

  onUpdate(listener: StateListener): void {
    this.listeners.push(listener);
  }
}

function hashAgents(agents: Agent[]): string {
  let h = agents.length + ':';
  for (const a of agents) {
    h += a.sessionId + '|' + a.pid + '|' + a.status + '|' + a.currentTask + '|' +
         a.contextTokens + '|' + a.activeSubs + '|' + (a.tasks?.length ?? 0) + '|' +
         a.commitsToday + '|' + a.branch + '|' + (a.awaitingChoice ? '1' : '0') + '|' +
         (a.devUrls?.join(',') ?? '') + '|' + pickerHash(a.picker) + '|';
  }
  return h;
}

// pickerHash captures the parts of a picker that drive the rendered
// UI. Cursor moves DON'T re-render here (we don't track cursor in
// the UI), so they'd cause a needless rebuild every time the user
// arrows up/down inside the agent's terminal. Question text +
// option count + concatenated labels are enough to detect a real
// new picker vs. a tick-by-tick re-emit of the same one.
function pickerHash(p: { question: string; options: { number: number; label: string }[] } | null | undefined): string {
  if (!p) return '_';
  let h = p.question + ':' + p.options.length;
  for (const o of p.options) h += '|' + o.number + ':' + o.label;
  return h;
}
