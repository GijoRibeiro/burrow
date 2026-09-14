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
