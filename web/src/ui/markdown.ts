export function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks: ```lang\n...\n```
  html = html.replace(/```\w*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold + italic
  html = html.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>');

  // Headers (## etc) — just bold them
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');

  // GFM tables → real <table>. Runs after inline formatting so cell
  // contents already carry their <strong>/<code>/<em>, and before the
  // newline→<br> pass so the table block can be collapsed to a single
  // newline-free line (the container is white-space: pre-wrap, so any
  // stray newline inside the table HTML would render as literal space).
  html = renderTables(html);

  // Unordered list items
  html = html.replace(/^[-*]\s+(.+)$/gm, '  · $1');

  // Unescape a small whitelist of HTML tags that agents commonly use
  // for collapsible sections (GitHub-flavored markdown)
  html = html
    .replace(/&lt;details&gt;/g, '<details>')
    .replace(/&lt;\/details&gt;/g, '</details>')
    .replace(/&lt;summary&gt;/g, '<summary>')
    .replace(/&lt;\/summary&gt;/g, '</summary>');

  // Collapse multiple blank lines
  html = html.replace(/\n{3,}/g, '\n\n');

  // Double newline → paragraph break, single newline → line break
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');

  // Tables are block-level — drop the <br>s the newline pass left
  // hugging them so they don't open a gaping blank line above/below.
  html = html
    .replace(/(?:<br>\s*)+<table/g, '<table')
    .replace(/<\/table>(?:\s*<br>)+/g, '</table>');

  return html.trim();
}

// Convert GFM table blocks to <table> HTML, leaving non-table lines
// untouched. A block is a row line, a separator line (pipes + dashes,
// optional alignment colons), then zero or more row lines. The whole
// block collapses to one newline-free <table> string so the later
// newline→<br> pass and the pre-wrap container don't mangle it.
function renderTables(src: string): string {
  const lines = src.split('\n');
  // Separator: only pipes / dashes / colons / spaces, with at least one
  // of each of a pipe and a dash. The pipe requirement is what tells a
  // table separator apart from a `---` thematic rule.
  const isSep = (l: string) => /\|/.test(l) && /-/.test(l) && /^[\s:|-]+$/.test(l);
  const isRow = (l: string) => l.includes('|') && /\S/.test(l) && !isSep(l);

  // Split a row into trimmed cells, tolerating optional outer pipes.
  const cells = (l: string): string[] => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (header !== undefined && sep !== undefined && isRow(header) && isSep(sep)) {
      const heads = cells(header);
      // Per-column alignment from the separator's colons.
      const aligns = cells(sep).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const align = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');

      // Consume body rows until a non-row line.
      const body: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) {
        body.push(cells(lines[j]));
        j++;
      }

      const thead = '<thead><tr>' + heads.map((h, k) => `<th${align(k)}>${h}</th>`).join('') + '</tr></thead>';
      const tbody = '<tbody>' + body.map((row) =>
        '<tr>' + heads.map((_, k) => `<td${align(k)}>${row[k] ?? ''}</td>`).join('') + '</tr>'
      ).join('') + '</tbody>';
      out.push(`<table class="chat-table">${thead}${tbody}</table>`);
      i = j - 1; // skip the lines we just consumed
    } else {
      out.push(header);
    }
  }
  return out.join('\n');
}

export function renderToolUse(toolName: string, inputJson: string): string {
  let header = `<div class="tool-header">${toolName}</div>`;
  try {
    const parsed = JSON.parse(inputJson);
    if (toolName === 'Edit') {
      const file = parsed.file_path || '';
      header = `<div class="tool-header">Edit ${file.split('/').slice(-2).join('/')}</div>`;
      let diff = '';
      if (parsed.old_string) {
        diff += parsed.old_string.split('\n').map((l: string) =>
          `<div class="diff-removed">- ${l.replace(/</g, '&lt;')}</div>`
        ).join('');
      }
      if (parsed.new_string) {
        diff += parsed.new_string.split('\n').map((l: string) =>
          `<div class="diff-added">+ ${l.replace(/</g, '&lt;')}</div>`
        ).join('');
      }
      return header + `<pre class="tool-diff">${diff}</pre>`;
    }
    if (toolName === 'Bash') {
      const cmd = parsed.command || '';
      return header + `<pre class="tool-command">$ ${cmd.replace(/</g, '&lt;')}</pre>`;
    }
    if (toolName === 'Read') {
      const file = parsed.file_path || '';
      return `<div class="tool-header">Read ${file.split('/').slice(-2).join('/')}</div>`;
    }
    if (toolName === 'Write') {
      const file = parsed.file_path || '';
      return `<div class="tool-header">Write ${file.split('/').slice(-2).join('/')}</div>`;
    }
    if (toolName === 'Grep') {
      const pattern = parsed.pattern || '';
      return `<div class="tool-header">Grep ${pattern.replace(/</g, '&lt;')}</div>`;
    }
    if (toolName === 'Glob') {
      const pattern = parsed.pattern || '';
      return `<div class="tool-header">Glob ${pattern.replace(/</g, '&lt;')}</div>`;
    }
  } catch { /* ignore parse errors */ }
  return header;
}

// Single-line plaintext summary of a tool call, suitable for a live
// status chip ("agent is doing X right now"). Pulls the same fields
// renderToolUse uses, but without HTML chrome and trimmed to a max
// length so it doesn't blow out the active-agents bar.
export function summarizeToolCall(toolName: string, inputJson: string, max = 48): string {
  const tail = (s: string) => s.split('/').filter(Boolean).slice(-2).join('/');
  const trim = (s: string) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  let label = toolName;
  try {
    const p = JSON.parse(inputJson || '{}');
    switch (toolName) {
      case 'Read':       label = `Read ${tail(p.file_path || '')}`; break;
      case 'Write':      label = `Write ${tail(p.file_path || '')}`; break;
      case 'Edit':       label = `Edit ${tail(p.file_path || '')}`; break;
      case 'NotebookEdit': label = `Edit ${tail(p.notebook_path || p.file_path || '')}`; break;
      case 'Bash':       label = `Bash ${(p.command || '').split('\n')[0]}`; break;
      case 'Grep':       label = `Grep ${p.pattern || ''}`; break;
      case 'Glob':       label = `Glob ${p.pattern || ''}`; break;
      case 'WebFetch':   label = `Fetch ${p.url || ''}`; break;
      case 'WebSearch':  label = `Search ${p.query || ''}`; break;
      case 'TodoWrite':  label = `Tasks ×${(p.todos || []).length}`; break;
      case 'Task':       label = `Subagent ${p.subagent_type || ''}`; break;
    }
  } catch { /* ignore */ }
  return trim(label);
}
