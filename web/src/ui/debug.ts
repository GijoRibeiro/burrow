const MAX_DEBUG_LINES = 200;

export function toggleDebugPanel() {
  const panel = document.getElementById('debug-panel')!;
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
}

export function appendDebugLog(text: string) {
  const output = document.getElementById('debug-output');
  if (!output) return;

  const line = document.createElement('div');
  line.className = 'debug-line';

  const ts = document.createElement('span');
  ts.className = 'debug-ts';
  ts.textContent = new Date().toLocaleTimeString();

  line.appendChild(ts);
  line.appendChild(document.createTextNode(text));
  output.appendChild(line);

  while (output.children.length > MAX_DEBUG_LINES) {
    output.removeChild(output.firstChild!);
  }

  output.scrollTop = output.scrollHeight;
}
