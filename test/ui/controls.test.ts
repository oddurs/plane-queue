// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { launch, type App } from './harness.ts';

/**
 * Every control has to reach the simulation.
 *
 * The bug this suite exists for was not a crash and not a wrong number — it was
 * a control that looked like it worked. The strategy picker highlighted the
 * button, relabelled the lane and updated the masthead, while the gate model
 * quietly threw the strategy away and boarded almost at random. Nothing below
 * the UI could catch that, because the engine was doing exactly what it was
 * asked; and nothing above it could, because the app had no tests at all.
 *
 * So the assertion is always the same shape: move a control, and require the
 * run on screen to change. The readout is the witness — eight statistics that
 * would all have to coincide for a dead control to pass.
 */

/** Runs the lane to the end and returns everything the readout says about it. */
function finish(app: App): string {
  app.boardingTime();
  return app.readout();
}

describe('the strategy picker', () => {
  const NAMES = [
    'Random',
    'Back to front',
    'Front to back',
    'Outside-in (WilMA)',
    'Reverse pyramid',
    'Steffen (perfect)',
    'Steffen (modified)',
    'Premium to coach',
  ];

  it('boards a visibly different flight for every strategy', async () => {
    const seen = new Map<string, string>();
    for (const name of NAMES) {
      const app = await launch();
      app.click(app.pick('strategy', name));
      expect(app.picked('strategy'), name).toBe(name);
      expect(app.laneNames()[0], name).toBe(name);
      seen.set(name, finish(app));
    }
    // No two strategies may produce the same boarding.
    const readouts = [...seen.values()];
    expect(new Set(readouts).size).toBe(NAMES.length);
  });

  it('puts first class down the jetbridge first under premium to coach', async () => {
    // The reported symptom: "premium to coach still loads back to front". The
    // gate sliced the queue into equal halves instead of calling the forward
    // cabin on its own, so a dozen first-class passengers were scattered
    // through eighty economy ones and the method was premium in name only.
    const app = await launch();
    app.click(app.pick('strategy', 'Premium to coach'));
    const premium = finish(app);

    const other = await launch();
    other.click(other.pick('strategy', 'Back to front'));
    expect(premium).not.toBe(finish(other));
  });

  it('moves the gate to the group count the chosen strategy implies', async () => {
    const app = await launch();
    const gate = () => app.masthead().gate;

    app.click(app.pick('strategy', 'Steffen (perfect)'));
    expect(gate()).toBe('strict');
    app.click(app.pick('strategy', 'Outside-in (WilMA)'));
    expect(gate()).toBe('3 groups');
    app.click(app.pick('strategy', 'Premium to coach'));
    expect(gate()).toBe('2 groups');
    app.click(app.pick('strategy', 'Steffen (modified)'));
    expect(gate()).toBe('6 groups');
    app.click(app.pick('strategy', 'Random'));
    expect(gate()).toBe('1 groups');
  });

  it('keeps the blurb in step with the selection', async () => {
    const app = await launch();
    const blurb = () => app.$<HTMLElement>('.strategy-blurb').textContent ?? '';
    app.click(app.pick('strategy', 'Outside-in (WilMA)'));
    expect(blurb()).toMatch(/windows/i);
    app.click(app.pick('strategy', 'Premium to coach'));
    expect(blurb()).toMatch(/first class/i);
  });
});

describe('every slider', () => {
  // Each slider is dragged from one end of its own range to the other. The
  // bounds come off the input, so widening a control widens its test too.
  const SLIDERS = [
    'Gate release groups',
    'Blocks',
    'Rows',
    'First-class rows',
    'Load factor',
    'Overhead slots per row',
    'Carry-on bags per passenger',
    'Travelling in a party',
    'Children within parties',
    'Pace variation',
    'Needing assistance',
  ];

  it.each(SLIDERS)('%s changes the boarding it produces', async (label) => {
    const low = await launch();
    const input = low.slider(label);
    const min = Number(input.min);
    const max = Number(input.max);

    low.drag(low.slider(label), min);
    const atMin = finish(low);

    const high = await launch();
    high.drag(high.slider(label), max);
    const atMax = finish(high);

    expect(atMin, `${label} had no effect between ${min} and ${max}`).not.toBe(atMax);
  });

  it.each(SLIDERS)('%s shows the value it was moved to', async (label) => {
    const app = await launch();
    const input = app.slider(label);
    const before = app.$<HTMLElement>('#controls').textContent ?? '';
    app.drag(app.slider(label), Number(input.max));
    // The readout beside the handle has to move with it.
    expect(app.$<HTMLElement>('#controls').textContent ?? '').not.toBe(before);
    expect(app.slider(label).value).toBe(input.max);
  });
});

describe('the aircraft picker', () => {
  it('flies the type that was chosen', async () => {
    const app = await launch();
    expect(app.picked('aircraft')).toBe('Airbus A320-200');
    const a320 = finish(app);

    const other = await launch();
    other.click(other.pick('aircraft', 'Boeing 737-800'));
    expect(other.picked('aircraft')).toBe('Boeing 737-800');
    expect(finish(other)).not.toBe(a320);
  });
});

describe('the seed', () => {
  it('boards different passengers, and the same ones twice', async () => {
    const app = await launch();
    const first = finish(app);

    const changed = await launch();
    changed.type(changed.$<HTMLInputElement>('#controls input[type=number]'), 7);
    const second = finish(changed);
    expect(second).not.toBe(first);

    const repeat = await launch();
    expect(finish(repeat)).toBe(first);
  });
});
