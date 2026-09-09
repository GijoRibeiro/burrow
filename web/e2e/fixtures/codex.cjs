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
