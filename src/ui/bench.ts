import { comparePins, type Pin } from '../engine/bench.ts';
import { formatDuration } from '../engine/stats.ts';

/**
 * The bench view: pinned runs, and a verdict on any two of them.
 *
 * Selection is the whole interaction. Pick two pins and the app says whether
 * the difference between them survives its own noise test — the same bar every
 * other claim on the page has to clear.
 */

const STORAGE_KEY = 'plane-queue.bench.v1';

export function loadPins(): Pin[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Pin[]) : [];
  } catch {
    // A corrupt or unavailable store must not take the app down with it.
    return [];
  }
}

export function savePins(pins: Pin[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    /* private browsing, quota, or no storage at all — the bench just won't persist */
  }
}

export interface BenchHandlers {
  onSelect(id: string): void;
  onRestore(pin: Pin): void;
  onDelete(id: string): void;
}

export function renderBench(
  host: HTMLElement,
  pins: Pin[],
  selected: string[],
  handlers: BenchHandlers,
): void {
  host.replaceChildren();

  if (pins.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent =
      'Nothing pinned yet. Set up a scenario, press PIN above the cabin, and it is kept here with a proper sample behind it — then pin a second one and the bench will tell you whether the difference between them is real.';
    host.append(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'pin-list';

  // Fastest first: the bench is for ranking experiments, not logging them.
  for (const pin of [...pins].sort((a, b) => a.time.mean - b.time.mean)) {
    const item = document.createElement('li');
    const isSelected = selected.includes(pin.id);
    item.className = 'pin' + (isSelected ? ' selected' : '');

    const pick = document.createElement('button');
    pick.className = 'pin-pick';
    pick.setAttribute('aria-pressed', String(isSelected));
    pick.innerHTML =
      `<span class="pin-label">${escapeHtml(pin.label)}</span>` +
      `<span class="pin-time">${formatDuration(pin.time.mean)}</span>` +
      `<span class="pin-spread">±${(2 * pin.time.sd).toFixed(0)}s over ${pin.time.n} runs` +
      `${pin.incompleteRuns > 0 ? ' · CAPPED' : ''}</span>`;
    pick.addEventListener('click', () => handlers.onSelect(pin.id));

    const actions = document.createElement('div');
    actions.className = 'pin-actions';

    const restore = document.createElement('button');
    restore.className = 'btn';
    restore.textContent = 'LOAD';
    restore.title = 'Put this scenario back on the bench and carry on from it';
    restore.addEventListener('click', () => handlers.onRestore(pin));

    const remove = document.createElement('button');
    remove.className = 'btn';
    remove.textContent = 'DROP';
    remove.addEventListener('click', () => handlers.onDelete(pin.id));

    actions.append(restore, remove);
    item.append(pick, actions);
    list.append(item);
  }

  host.append(list);

  const [aId, bId] = selected;
  const a = pins.find((p) => p.id === aId);
  const b = pins.find((p) => p.id === bId);
  const comparison = a && b ? comparePins(a, b) : null;

  const verdict = document.createElement('p');
  if (comparison) {
    verdict.className =
      'verdict pin-verdict' + (comparison.significant ? '' : ' pin-verdict-null');
    verdict.innerHTML = comparison.verdict.replace(
      comparison.faster.label,
      `<strong>${escapeHtml(comparison.faster.label)}</strong>`,
    );
  } else {
    verdict.className = 'note';
    verdict.textContent =
      selected.length === 1
        ? 'One selected. Pick a second pin to compare them.'
        : 'Select two pins to compare them.';
  }
  host.append(verdict);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
