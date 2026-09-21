#!/usr/bin/env node
// Local CLI fixture: real process/PTY/transcript lifecycle, no model requests.
const fs = require('node:fs'), path = require('node:path');
const config = process.env.CLAUDE_CONFIG_DIR;
const id = `fixture-${process.pid}`;
const sessions = path.join(config, 'sessions'), project = path.join(config, 'projects', 'fixture');
fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(project, { recursive: true });
const metadata = path.join(sessions, `${process.pid}.json`), transcript = path.join(project, `${id}.jsonl`);
fs.writeFileSync(metadata, JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd() }));
fs.writeFileSync(transcript, '');
process.on('exit', () => { try { fs.unlinkSync(metadata); } catch {} });
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004hClaude fixture ready\r\n');
let input = '', turn = 0;
process.stdin.on('data', data => {
  input += data;
  let end;
  while ((end = input.indexOf('\r')) >= 0) {
    const text = input.slice(0, end).replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
    input = input.slice(end + 1);
    if (text === '/exit') process.exit(0);
    if (/^\/[a-z][\w:-]*(?:\s|$)/i.test(text)) {
      process.stdout.write(`Fixture command menu: ${text}\r\n`);
      continue;
    }
    if (text.includes('You are now attached to a Burrow head.')) {
      const { execFileSync } = require('node:child_process');
      const run = (...args) => JSON.parse(execFileSync(process.env.BURROW_CLI, args, {encoding:'utf8'}));
      for (const message of run('inbox')) run('ack', message.id);
      run('send', 'parent', 'Existing agent connected; current work preserved.');
    }
    if (text.startsWith('Fixture queued prompt:')) {
      const sequence = ++turn;
      const progress = `Live progress for queued turn ${sequence}`;
      fs.appendFileSync(transcript, JSON.stringify({type:'assistant',uuid:`progress-${sequence}`,message:{content:progress}})+'\n');
      process.stdout.write(progress+'\r\n');
      setTimeout(() => {
        const reply = `Queued prompt received: ${text}`;
        fs.appendFileSync(transcript, JSON.stringify({type:'attachment',uuid:`attachment-${sequence}`,attachment:{type:'queued_command',commandMode:'prompt',origin:{kind:'human'},source_uuid:`u${sequence}`,prompt:text}})+'\n'+JSON.stringify({type:'assistant',uuid:`a${sequence}`,message:{content:reply,stop_reason:'end_turn'}})+'\n');
        process.stdout.write(reply.replaceAll('\n','\r\n')+'\r\n');
      }, 6000);
      continue;
    }
    const response = `Claude received: ${text}`;
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: `u${++turn}`, message: { content: text } }) + '\n' + JSON.stringify({ type: 'assistant', uuid: `a${turn}`, message: { content: response, stop_reason: 'end_turn' } }) + '\n');
    process.stdout.write(response.replaceAll('\n', '\r\n') + '\r\n');
  }
});
