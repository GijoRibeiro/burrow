#!/usr/bin/env node
// Interactive local fixture, with no account or model calls.
if (!process.argv.includes('--dangerously-bypass-approvals-and-sandbox')) process.exit(2);
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = process.env.CLOOVIES_CODEX_FIXTURE_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || require("node:os").tmpdir(), "codex-fixture");
fs.mkdirSync(path.join(root, 'thread-writer-locks'), {recursive:true});
const thread = randomUUID();
const lock = fs.openSync(path.join(root, 'thread-writer-locks', `${thread}.lock`), 'w');
let log;
const record = (type, payload) => {
  if (log === undefined) {
    log = fs.openSync(path.join(root, `rollout-fixture-${thread}.jsonl`), 'a');
    fs.writeSync(log, JSON.stringify({type:'session_meta',payload:{id:thread,cwd:process.cwd()}})+'\n');
  }
  fs.writeSync(log, JSON.stringify({type,payload})+'\n');
};
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004h\x1b[36mCodex fixture ready · YOLO\x1b[0m\r\n');
let input = '', draft = '', images = [], turn = 0;
function paste(text) {
  if (/\.(png|jpe?g|gif)$/i.test(text) && fs.existsSync(text)) {
    images.push(text); process.stdout.write(`[Image #${images.length}]\r\n`);
  } else draft += text;
}
function submit() {
  const text = draft; draft = '';
  if (text === '/exit') process.exit(0);
  if (text.startsWith('/')) { process.stdout.write(`Fixture command menu: ${text}\r\n`); return; }
  const current = ++turn;
  record('event_msg',{type:'task_started'});
  record('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'INJECTED ENVIRONMENT MUST NOT APPEAR'}]});
  const attachments = images; images = [];
  record('event_msg',{type:'item_completed',item:{type:'UserMessage',id:`u${current}`,content:[...attachments.map(path=>({type:'local_image',path})),{type:'text',text:attachments.map((_,i)=>`[Image #${i+1}] `).join('')+text}]}});
  setTimeout(()=>{
    const response = `Codex received: ${text}${attachments.length ? ` · ${attachments.length} native image(s)` : ''}`;
    record('event_msg',{type:'item_completed',item:{type:'Reasoning',id:`r${current}`,summary_text:['PRIVATE REASONING MUST NOT APPEAR']}});
    record('event_msg',{type:'item_completed',item:{type:'AgentMessage',id:`a${current}`,content:[{type:'Text',text:response}]}});
    record('response_item',{type:'message',role:'assistant',id:`a${current}`,content:[{type:'output_text',text:response}]});
    record('event_msg',{type:'task_complete',last_agent_message:response});
    process.stdout.write(response.replaceAll('\n','\r\n')+'\r\n');
  },2500);
}
process.stdin.on('data', data => {
  input += data;
  while(input.length) {
    if (input.startsWith('\x1b[200~')) {
      const end=input.indexOf('\x1b[201~'); if(end<0) break;
      paste(input.slice(6,end)); input=input.slice(end+6); continue;
    }
    if ('\x1b[200~'.startsWith(input)) break;
    const char=input[0]; input=input.slice(1);
    if(char==='\r') submit();
    else if(char==='\t') process.stdout.write('NATIVE TAB\r\n');
    else if(char==='\x7f') draft=draft.slice(0,-1);
    else draft+=char;
  }
});
// A delegated fixture exercises the actual workspace CLI from inside tmux.
if (process.argv.some(arg => arg.startsWith('You are working in an isolated child worktree'))) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('burrow', ['send', 'parent', 'Fixture question: which endpoint should I implement?']);
    execFileSync('burrow', ['status', 'waiting', 'Waiting for endpoint details']);
    process.stdout.write('Coordination fixture connected\r\n');
  } catch (error) {
    process.stdout.write(`Coordination fixture failed: ${error.message}\r\n`);
  }
}
// Head fixture drives the real proposal CLI; it never calls an AI provider.
if (process.argv.some(arg => arg.includes('You are the head agent for a Burrow team.'))) {
  const { execFileSync } = require('node:child_process');
  const run = (...args) => JSON.parse(execFileSync('burrow', args, { encoding: 'utf8' }));
  const plans = run('plans');
  if (!plans.length) {
    run('propose', JSON.stringify({
      title: 'A focused morning',
      summary: 'Three independent tasks. I will coordinate the workers and surface questions here.',
      items: ['Checkout navigation', 'Insurance options', 'Portal metrics'].map((title, i) => ({
        name: `morning-${i + 1}`, title, program: 'codex', instructions: `TEAM_FIXTURE: implement ${title}, verify it, and report to the head.`,
      })),
    }));
    process.stdout.write('Head: Three independent workers are running. You can talk to them on the canvas.\r\n');
  }
  setInterval(() => {
    try {
      for (const message of run('inbox')) {
        if (message.from !== 'user') run('send', message.from, 'Head reply: use /api/team and keep the existing behavior.');
        process.stdout.write(`Head update: ${message.text}\r\n`);
        run('ack', message.id);
      }
    } catch { /* The server can be briefly unavailable during test teardown. */ }
  }, 1200);
}

if (process.argv.some(arg => arg.startsWith('You are working in an isolated child worktree') && arg.includes('TEAM_FIXTURE'))) {
  const { execFileSync } = require('node:child_process');
  const run = (...args) => JSON.parse(execFileSync('burrow', args, { encoding: 'utf8' }));
  const check = setInterval(() => {
    try {
      const messages = run('inbox');
      if (messages.some(m => m.text.startsWith('Head reply:'))) {
        for (const message of messages) run('ack', message.id);
        run('status', 'working', 'Head clarified the endpoint; implementation underway.');
        process.stdout.write('Worker: received the head reply and resumed work.\r\n');
        clearInterval(check);
      }
    } catch { /* Server may be stopping. */ }
  }, 1200);
}
