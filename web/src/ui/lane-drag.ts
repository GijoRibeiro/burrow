// Drag agent frames from the grid into the chat-lanes container to
// open a dedicated lane for that agent. Uses a dedicated MIME type so
// it doesn't collide with section-drag, file-drop, or Linear card
// drag — each system listens for its own type.

const MIME = 'application/x-bitwise-agent';

// Attach the drag-source behavior to an agent frame. Called once per
// frame at creation time. Idempotent: safe to call again on re-render.
export function attachLaneDragSource(frame: HTMLElement, cwd: string): void {
  if (frame.dataset.laneDragAttached === '1') {
    // Cwd may be the same — skip.
    return;
  }
  frame.dataset.laneDragAttached = '1';
  frame.dataset.cwd = cwd;
  frame.draggable = true;

  frame.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    const target = frame.dataset.cwd || cwd;
    e.dataTransfer.setData(MIME, target);
    e.dataTransfer.setData('text/plain', target); // friendly fallback
    e.dataTransfer.effectAllowed = 'copy';
    frame.classList.add('lane-drag-source');
  });

  frame.addEventListener('dragend', () => {
    frame.classList.remove('lane-drag-source');
  });
}

// One-time setup on the lanes container. The drop fires the supplied
// callback with the cwd; lanes.ts handles add-or-flash logic.
export function setupLaneDropTarget(
  container: HTMLElement,
  onDrop: (cwd: string) => void,
): void {
  if (container.dataset.laneDropTargetAttached === '1') return;
  container.dataset.laneDropTargetAttached = '1';

  container.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes(MIME)) return;
    e.preventDefault();
    container.classList.add('lane-drop-target');
  });

  container.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes(MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  container.addEventListener('dragleave', (e) => {
    // dragleave fires on every child crossing; only clear when we
    // actually leave the container.
    if (e.target === container) container.classList.remove('lane-drop-target');
  });

  container.addEventListener('drop', (e) => {
    if (!e.dataTransfer) return;
    const cwd = e.dataTransfer.getData(MIME);
    container.classList.remove('lane-drop-target');
    if (!cwd) return;
    e.preventDefault();
    onDrop(cwd);
  });
}
