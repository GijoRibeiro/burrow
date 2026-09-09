import { CreatureDefinition } from '../types';

const STARTER_CREATURES: CreatureDefinition[] = [
  { id: 'creature-01', name: 'Sprout', spriteSheet: '/assets/sprites/creature-01.png', color: '#a0d0a0' },
  { id: 'creature-02', name: 'Ember', spriteSheet: '/assets/sprites/creature-02.png', color: '#d0a0a0' },
  { id: 'creature-03', name: 'Dewdrop', spriteSheet: '/assets/sprites/creature-03.png', color: '#a0c0d0' },
];

export interface PickerResult {
  creatureId: string;
  name: string;
}

export function showCreaturePicker(): Promise<PickerResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const modal = document.createElement('div');
    modal.className = 'picker-modal';
    modal.innerHTML = `
      <h2 class="picker-title">Choose a Creature</h2>
      <div class="picker-grid">
        ${STARTER_CREATURES.map(
          (c) => `
          <div class="picker-creature" data-id="${c.id}" style="border-color: ${c.color}">
            <div class="picker-sprite" style="background: ${c.color}; width: 48px; height: 72px; border-radius: 4px;"></div>
            <span class="picker-creature-name">${c.name}</span>
          </div>
        `
        ).join('')}
      </div>
      <div class="picker-name-row" style="display:none">
        <label>Name your creature:</label>
        <input type="text" class="picker-name-input" placeholder="Enter a name..." autocomplete="off" />
        <button class="picker-confirm">Confirm</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let selectedId = '';

    modal.querySelectorAll('.picker-creature').forEach((el) => {
      el.addEventListener('click', () => {
        modal.querySelectorAll('.picker-creature').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');
        selectedId = (el as HTMLElement).dataset.id!;
        const nameRow = modal.querySelector('.picker-name-row') as HTMLElement;
        nameRow.style.display = 'flex';
        const input = modal.querySelector('.picker-name-input') as HTMLInputElement;
        input.focus();
      });
    });

    const confirmBtn = modal.querySelector('.picker-confirm') as HTMLButtonElement;
    const nameInput = modal.querySelector('.picker-name-input') as HTMLInputElement;

    confirmBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (selectedId && name) {
        document.body.removeChild(overlay);
        resolve({ creatureId: selectedId, name });
      }
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') {
        document.body.removeChild(overlay);
        resolve(null);
      }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(null);
      }
    });
  });
}
