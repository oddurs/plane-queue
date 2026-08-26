// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { launch } from './harness.ts';

/**
 * Where the run's figures are, and what is not repeated.
 *
 * They used to sit under the drawing — the thing you read furthest from the
 * thing you watch, with the aircraft standing on top of its own statistics —
 * alongside a paragraph of strategy blurb that was already printed under the
 * picker that sets it.
 */

describe('the run readout', () => {
  it('sits above the drawing, not below it', async () => {
    const app = await launch();
    const lane = app.$<HTMLElement>('.lane');
    const head = app.$<HTMLElement>('.lane-head');
    const canvas = app.$<HTMLElement>('.canvas-wrap');
    const order = [...lane.children];
    expect(order.indexOf(head)).toBeLessThan(order.indexOf(canvas));
    expect(head.contains(app.$('.readout'))).toBe(true);
  });

  it('gives the clock and the seat count their own rank', async () => {
    const app = await launch();
    const key = app.all<HTMLElement>('.stats-key .stat span').map((s) => s.textContent);
    expect(key).toEqual(['Elapsed', 'Seated']);
    // Everything else is there, just quieter.
    const rest = app.all<HTMLElement>('.stats-rest .stat span').map((s) => s.textContent);
    expect(rest).toContain('Waiting');
    expect(rest).toContain('Crew hold');
    expect(key.length + rest.length).toBe(10);
  });

  it('keeps the clock as the element that reports the run is over', async () => {
    // One element, not two: the elapsed figure is also the finished marker.
    const app = await launch();
    const clock = app.$<HTMLElement>('.lane-time');
    expect(clock.closest('.stat')?.querySelector('span')?.textContent).toBe('Elapsed');
    expect(clock.classList.contains('finished')).toBe(false);
    app.boardingTime();
    expect(clock.classList.contains('finished')).toBe(true);
  });

  it('names every lane in a race', async () => {
    const app = await launch();
    app.click(app.$('#race'));
    const names = app.all<HTMLElement>('.lane-name');
    expect(names.length).toBe(2);
    for (const name of names) expect(name.textContent).not.toBe('');
    expect(app.all('.readout').length).toBe(2);
  });
});

describe('what is no longer said twice', () => {
  it('drops the strategy blurb from over the aircraft', async () => {
    const app = await launch();
    expect(app.all('#strategy-note').length).toBe(0);
    // It still answers the question where the question is asked.
    app.click(app.$('#inspector-toggle'));
    expect(app.$<HTMLElement>('.strategy-blurb').textContent).toMatch(/Rear blocks first/);
  });

  it('leaves the strategy to the lane rather than the masthead', async () => {
    const app = await launch();
    expect(app.masthead()).not.toHaveProperty('strategy');
    app.click(app.pick('strategy', 'Outside-in (WilMA)'));
    expect(app.laneNames()[0]).toBe('Outside-in (WilMA)');
  });
});
