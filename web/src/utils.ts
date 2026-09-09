export function formatElapsed(ms: number): string {
  if (!ms || ms < 1000) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function formatTokens(n: number): string {
  if (!n) return '';
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

export function shortenPath(path: string): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1];
}
