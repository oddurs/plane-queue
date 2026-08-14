/**
 * Task-based views.
 *
 * The page had grown a panel per feature, all visible at once and all at the
 * same visual weight. Splitting by activity — read the brief, watch a run,
 * compare, search, check the sources — means each screen has one job.
 *
 * Hidden views have zero width, so anything that sizes itself from the DOM
 * (canvases, SVGs measured against their container) has to be repainted when
 * its view becomes visible rather than when it was built.
 */
export interface TabController {
  readonly active: string;
  show(name: string): void;
}

export function createTabs(
  nav: HTMLElement,
  views: HTMLElement,
  onShow: (name: string) => void,
): TabController {
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...views.querySelectorAll<HTMLElement>('[data-view]')];
  let active = '';

  function show(name: string): void {
    active = name;
    for (const button of buttons) {
      const selected = button.dataset['tab'] === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset['view'] !== name;
    }
    onShow(name);
  }

  for (const button of buttons) {
    button.addEventListener('click', () => show(button.dataset['tab'] ?? ''));
  }

  // Left/right arrows move between tabs, as a tablist is expected to.
  nav.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = buttons.findIndex((b) => b.dataset['tab'] === active);
    const next = buttons[(index + step + buttons.length) % buttons.length];
    if (next) {
      show(next.dataset['tab'] ?? '');
      next.focus();
    }
  });

  return {
    get active() {
      return active;
    },
    show,
  };
}
