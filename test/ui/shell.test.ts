// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { launch } from './harness.ts';

/**
 * The shell: a bar at each edge and the cabin between them.
 *
 * The controls that drive the simulation are worth nothing if you have to go
 * looking for them, so the rule these check is that both bars are always there
 * and always reachable — including while analysis is open over the top, which
 * is the whole reason it is a sheet and not a page.
 */

describe('the frame', () => {
  it('puts the transport in a bar of its own, not in the scrolling column', async () => {
    const app = await launch();
    const bar = app.$<HTMLElement>('.bottombar');
    for (const id of ['play', 'step', 'reset', 'speed']) {
      expect(bar.contains(app.$(`#${id}`)), id).toBe(true);
    }
  });

  it('keeps the analysis out of the way until it is asked for', async () => {
    const app = await launch();
    expect(app.$<HTMLElement>('#analysis').hidden).toBe(true);
    expect(app.$<HTMLElement>('#analysis-scrim').hidden).toBe(true);
    // The old inline drawer is gone entirely.
    expect(app.all('#drawer-handle').length).toBe(0);
  });

  it('holds the tabs and every view inside the sheet', async () => {
    const app = await launch();
    const sheet = app.$<HTMLElement>('#analysis');
    expect(sheet.contains(app.$('#tabs'))).toBe(true);
    expect(sheet.contains(app.$('#views'))).toBe(true);
    expect(sheet.contains(app.$('#precision'))).toBe(true);
  });
});

describe('the analysis sheet', () => {
  it('opens from the top bar and closes every way it should', async () => {
    const app = await launch();
    const sheet = () => app.$<HTMLElement>('#analysis');
    const toggle = app.$<HTMLButtonElement>('#analysis-toggle');

    app.click(toggle);
    expect(sheet().hidden).toBe(false);
    expect(app.$<HTMLElement>('#analysis-scrim').hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    app.click(app.$('#analysis-close'));
    expect(sheet().hidden).toBe(true);

    app.click(toggle);
    app.click(app.$('#analysis-scrim'));
    expect(sheet().hidden, 'clicking away did not dismiss it').toBe(true);

    app.click(toggle);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(sheet().hidden, 'escape did not dismiss it').toBe(true);
  });

  it('leaves the transport working while it is open', async () => {
    // The point of a sheet rather than a page: the run carries on underneath.
    const app = await launch();
    app.click(app.$('#analysis-toggle'));
    const before = app.stat('Elapsed');
    app.$<HTMLButtonElement>('#step').click();
    expect(app.stat('Elapsed')).not.toBe(before);
  });

  it('switches views from inside the sheet', async () => {
    const app = await launch();
    app.click(app.$('#analysis-toggle'));
    for (const tab of app.all<HTMLButtonElement>('#tabs [data-tab]')) {
      tab.click();
      const name = tab.dataset.tab as string;
      expect(tab.getAttribute('aria-selected'), name).toBe('true');
      const shown = app
        .all<HTMLElement>('#views [data-view]')
        .filter((panel) => !panel.hidden);
      expect(shown.map((panel) => panel.dataset.view), name).toEqual([name]);
    }
  });

  it('closes the configuration panel with escape too', async () => {
    const app = await launch();
    app.click(app.$('#inspector-toggle'));
    expect(app.$<HTMLElement>('#inspector').hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.$<HTMLElement>('#inspector').hidden).toBe(true);
  });
});
