#!/usr/bin/env node
// Interactive local fixture, with no account or model calls.
if (!process.argv.includes('--dangerously-bypass-approvals-and-sandbox')) process.exit(2);
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004hCodex fixture ready · YOLO\r\n');
let input = '';
process.stdin.on('data', data => {
  input += data;
  let end;
  while ((end = input.indexOf('\r')) >= 0) {
    const text = input.slice(0, end).replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
    input = input.slice(end + 1);
    if (text === '/exit') process.exit(0);
    process.stdout.write(`Codex received: ${text}\r\n`);
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
