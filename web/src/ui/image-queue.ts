// web/src/ui/image-queue.ts

export interface QueuedImage {
  id: number;
  dataUrl: string;
  base64: string;
}

let nextId = 0;
const images: QueuedImage[] = [];
let containerEl: HTMLElement | null = null;
let onChange: (() => void) | null = null;

export function initImageQueue(container: HTMLElement, onChangeCallback: () => void) {
  containerEl = container;
  onChange = onChangeCallback;
}

export function addImage(dataUrl: string) {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const img: QueuedImage = { id: nextId++, dataUrl, base64 };
  images.push(img);
  render();
  onChange?.();
}

export function addImageFromBase64(base64: string) {
  const dataUrl = 'data:image/png;base64,' + base64;
  const img: QueuedImage = { id: nextId++, dataUrl, base64 };
  images.push(img);
  render();
  onChange?.();
}

export function removeImage(id: number) {
  const idx = images.findIndex(i => i.id === id);
  if (idx !== -1) {
    images.splice(idx, 1);
    render();
    onChange?.();
  }
}

export function clearImages() {
  images.length = 0;
  render();
  onChange?.();
}

export function getImages(): QueuedImage[] {
  return [...images];
}

export function hasImages(): boolean {
  return images.length > 0;
}

function render() {
  if (!containerEl) return;
  // Defensive: the focused-lane reparenting (main.ts focusin) and
  // lane removal (lanes.ts removeLane) can both leave `containerEl`
  // detached from the document if a corner case slips through —
  // e.g., a lane is removed before evacuateSingletons can run.
  // Rendering into a detached node would silently swallow paste
  // previews ("sometimes the thumbnail doesn't show up"). When we
  // notice the stash has gone offline, re-resolve by id; if the
  // node is gone entirely, re-attach the stashed element to lane 0
  // so future pastes land somewhere visible.
  if (!containerEl.isConnected) {
    const live = document.getElementById('image-queue') as HTMLElement | null;
    if (live && live !== containerEl) {
      containerEl = live;
    } else {
      const laneZero = document.querySelector('.lane.lane-zero') as HTMLElement | null;
      if (laneZero) laneZero.appendChild(containerEl);
    }
  }
  containerEl.innerHTML = '';

  if (images.length === 0) {
    containerEl.style.display = 'none';
    return;
  }

  containerEl.style.display = 'flex';

  for (const img of images) {
    const thumb = document.createElement('div');
    thumb.className = 'image-thumb';
    thumb.title = 'click to preview';

    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;

    const removeBtn = document.createElement('span');
    removeBtn.className = 'image-thumb-remove';
    removeBtn.textContent = 'x';
    removeBtn.addEventListener('click', (e) => {
      // stopPropagation so the thumb's own click handler (preview)
      // doesn't fire on top of the remove. Otherwise removing an
      // image would also pop the now-deleted image's overlay.
      e.stopPropagation();
      removeImage(img.id);
    });

    // Click the thumb (anywhere except the × remove button) to open
    // a fullscreen preview — same overlay used by sent images in
    // the chat. Lets the user double-check what they pasted before
    // actually firing the message.
    thumb.addEventListener('click', () => {
      showImageOverlay(img.dataUrl);
    });

    thumb.appendChild(imgEl);
    thumb.appendChild(removeBtn);
    containerEl.appendChild(thumb);
  }
}

// Fullscreen image preview. Click outside the image (the dark
// backdrop) to dismiss. Inlined here rather than depending on
// main.ts so this module stays self-contained.
function showImageOverlay(src: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'image-overlay';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}
