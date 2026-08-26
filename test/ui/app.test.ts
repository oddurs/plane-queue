// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { launch, type App } from './harness.ts';

/**
 * The surfaces around the settings panel: the race, the transport, the presets,
 * the bench and the analysis tabs.
 *
 * Same rule as the controls suite — a thing the user operates has to change
 * what the app shows.
 */

function finish(app: App): string {
  app.boardingTime();
  return app.readout();
}

describe('the race', () => {
  it('never puts a strategy against itself', async () => {
    // Both lanes share a seed and a population, so a self-race is the identical
    // run twice: two matching cabins and a dead heat, which reads as a broken
    // picker. The default opponent used to be the default strategy.
    const app = await launch();
    app.click(app.$('#race'));
    const [a, b] = app.laneNames();
    expect(a).not.toBe(b);
    // ...and the two cabins genuinely diverge once they start boarding.
    const step = app.$<HTMLButtonElement>('#step');
    for (let i = 0; i < 200; i++) step.click();
    expect(app.readout(0)).not.toBe(app.readout(1));
  });

  it('keeps the opponent off lane A through every strategy', async () => {
    const app = await launch();
    app.click(app.$('#race'));
    for (const btn of app.all<HTMLButtonElement>('[data-picker="strategy"] .strategy')) {
      app.click(btn);
      const [a, b] = app.laneNames();
      expect(b, `${a} raced itself`).not.toBe(a);
      expect(app.all(`#opponent option[value]`).length).toBe(7);
    }
  });

  it('starts the race when an opponent is chosen', async () => {
    // The dropdown governs the second lane, which is not on screen until the
    // race is on — so picking from it used to do nothing anyone could see, and
    // read as a broken strategy picker sitting in the toolbar.
    const app = await launch();
    expect(app.laneNames().length).toBe(1);

    app.select(app.$<HTMLSelectElement>('#opponent'), 'steffen-perfect');
    expect(app.laneNames()).toEqual(['Back to front', 'Steffen (perfect)']);
    expect(app.$<HTMLInputElement>('#race').checked).toBe(true);
  });

  it('says what the dropdown is for', async () => {
    const app = await launch();
    expect(app.$<HTMLElement>('.versus').textContent).toBe('vs');
  });

  it('runs the opponent the dropdown names', async () => {
    const app = await launch();
    app.click(app.$('#race'));
    app.select(app.$<HTMLSelectElement>('#opponent'), 'steffen-perfect');
    expect(app.laneNames()[1]).toBe('Steffen (perfect)');
    app.select(app.$<HTMLSelectElement>('#opponent'), 'premium-first');
    expect(app.laneNames()[1]).toBe('Premium to coach');
  });

  it('declares a winner once both cabins are full', async () => {
    const app = await launch();
    app.click(app.$('#race'));
    app.click(app.pick('strategy', 'Steffen (perfect)'));
    app.select(app.$<HTMLSelectElement>('#opponent'), 'front-to-back');
    // Step until both lanes are done, not just the first.
    const step = app.$<HTMLButtonElement>('#step');
    for (let i = 0; i < 4000 && app.$<HTMLElement>('#verdict').hidden; i++) step.click();
    const verdict = app.$<HTMLElement>('#verdict');
    expect(verdict.hidden).toBe(false);
    expect(verdict.textContent).toContain('Steffen (perfect)');
  });

  it('drops back to one lane when the race is switched off', async () => {
    const app = await launch();
    app.click(app.$('#race'));
    expect(app.laneNames().length).toBe(2);
    app.click(app.$('#race'));
    expect(app.laneNames().length).toBe(1);
  });
});

describe('the transport', () => {
  it('steps the clock forward without playing', async () => {
    const app = await launch();
    const before = app.stat('Elapsed');
    app.$<HTMLButtonElement>('#step').click();
    expect(app.stat('Elapsed')).not.toBe(before);
    expect(app.$<HTMLButtonElement>('#play').textContent).toBe('Play');
  });

  it('resets a part-boarded cabin back to empty', async () => {
    const app = await launch();
    const step = app.$<HTMLButtonElement>('#step');
    for (let i = 0; i < 120; i++) step.click();
    expect(app.stat('Seated')).not.toMatch(/^0\//);
    app.$<HTMLButtonElement>('#reset').click();
    expect(app.stat('Seated')).toMatch(/^0\//);
    expect(app.stat('Elapsed')).toBe('0:00');
  });

  it('offers a replay once the cabin is full', async () => {
    const app = await launch();
    app.boardingTime();
    expect(app.$<HTMLButtonElement>('#play').textContent).toBe('Replay');
  });

  it('restarts the boarding when a control moves mid-run', async () => {
    const app = await launch();
    const step = app.$<HTMLButtonElement>('#step');
    for (let i = 0; i < 120; i++) step.click();
    app.click(app.pick('strategy', 'Outside-in (WilMA)'));
    expect(app.stat('Seated')).toMatch(/^0\//);
  });

  it('reports the speed the slider is set to', async () => {
    const app = await launch();
    const speed = app.$<HTMLInputElement>('#speed');
    speed.value = '30';
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.$<HTMLElement>('#speed-value').textContent).toBe('30×');
  });
});

describe('the toggles', () => {
  /**
   * Each toggle needs conditions under which it can bite. Gate-checking only
   * happens once the bins are full, so at the shipped defaults — one bag each,
   * eight slots a row — flipping it is correctly a no-op and would make a naive
   * test pass without proving anything.
   */
  const setUp: Record<string, (app: App) => void> = {
    'Gate-check bags when bins fill': (app) => {
      app.drag(app.slider('Carry-on bags per passenger'), 2.5);
      app.drag(app.slider('Overhead slots per row'), 3);
    },
    'Families board together': (app) => app.drag(app.slider('Travelling in a party'), 0.9),
    'Preboard passengers needing assistance': (app) =>
      app.drag(app.slider('Needing assistance'), 0.15),
  };

  it.each(Object.keys(setUp))('%s changes the boarding', async (label) => {
    const prepare = setUp[label] as (app: App) => void;

    const on = await launch();
    prepare(on);
    const before = finish(on);

    const off = await launch();
    prepare(off);
    const box = off.toggle(label);
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(finish(off), `${label} had no effect`).not.toBe(before);
  });
});

describe('the presets', () => {
  it('loads a whole scenario, panel and all', async () => {
    const app = await launch();
    const before = app.readout();
    const buttons = app.all<HTMLButtonElement>('#presets .preset');
    expect(buttons.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const btn of buttons) {
      app.click(btn);
      expect(btn.className).toContain('active');
      // The masthead is drawn from the scenario, so it proves the load landed.
      seen.add(JSON.stringify(app.masthead()));
      // And the panel must be showing the preset's strategy, not the old one.
      expect(app.picked('strategy')).toBe(app.laneNames()[0]);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(app.readout()).not.toBe(before);
  });
});

describe('the bench', () => {
  it('pins a finished run and can restore it', async () => {
    const app = await launch();
    app.click(app.pick('strategy', 'Steffen (perfect)'));
    app.$<HTMLButtonElement>('#pin').click();
    await new Promise((r) => setTimeout(r, 0));

    const pinned = app.all('#bench .pin, #bench li, #bench tr');
    expect(pinned.length, 'nothing landed on the bench').toBeGreaterThan(0);
    expect(app.$<HTMLElement>('#bench').textContent).toContain('Steffen');
  });
});

describe('the tabs', () => {
  it('shows one view at a time and switches on click', async () => {
    const app = await launch();
    // The tabs live inside the analysis sheet now, so it has to be open.
    app.click(app.$('#analysis-toggle'));
    const tabs = app.all<HTMLButtonElement>('#tabs [data-tab]');
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) {
      tab.click();
      const name = tab.dataset.tab as string;
      expect(tab.getAttribute('aria-selected'), name).toBe('true');
      // Exactly one panel is on screen, and it is this tab's.
      const shown = app
        .all<HTMLElement>('#views [data-view]')
        .filter((panel) => !panel.hidden);
      expect(shown.map((panel) => panel.dataset.view), name).toEqual([name]);
    }
  });
});
