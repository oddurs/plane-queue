// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { launch, type App } from './harness.ts';

/**
 * The assistance controls, driven the way a person drives them.
 *
 * The engine suite proves the model; this proves you can reach it. A taxonomy
 * nobody can select is the same as no taxonomy, and the aisle-chair case is
 * precisely the one that is invisible unless the panel lets you turn it up.
 */

const KINDS = ['Aisle chair', 'Own chair to the door', 'Reduced mobility', 'Escorted minor'];

function finish(app: App): string {
  app.boardingTime();
  return app.readout();
}

/** Puts the whole assisted share into one kind. */
function isolate(app: App, kind: string): void {
  app.drag(app.slider('Needing assistance'), 0.1);
  for (const other of KINDS) {
    app.drag(app.slider(other), other === kind ? 10 : 0);
  }
}

describe('the mobility assistance panel', () => {
  it('offers every kind once anyone is asking for help', async () => {
    const app = await launch();
    for (const kind of KINDS) expect(() => app.slider(kind), kind).not.toThrow();
  });

  it('hides the mix when nobody is asking', async () => {
    const app = await launch();
    app.drag(app.slider('Needing assistance'), 0);
    for (const kind of KINDS) expect(() => app.slider(kind), kind).toThrow();
  });

  it('shows how many passengers each weight works out to', async () => {
    const app = await launch();
    isolate(app, 'Aisle chair');
    const field = app.slider('Aisle chair').closest('.field') as HTMLElement;
    const readout = field.querySelector('output')?.textContent ?? '';
    // "n · 100%" — a headcount and its share, not a bare weight.
    expect(readout).toMatch(/^\d+ · 100%$/);
    expect(Number(readout.split(' ')[0])).toBeGreaterThan(0);

    const others = app.slider('Reduced mobility').closest('.field') as HTMLElement;
    expect(others.querySelector('output')?.textContent).toBe('0 · 0%');
  });

  it('boards a different flight for each kind', async () => {
    const seen = new Map<string, string>();
    for (const kind of KINDS) {
      const app = await launch();
      isolate(app, kind);
      seen.set(kind, finish(app));
    }
    expect(new Set(seen.values()).size, 'two kinds boarded identically').toBe(KINDS.length);
  });

  it('makes an aisle chair the slowest kind to board', async () => {
    const time = async (kind: string): Promise<number> => {
      const app = await launch();
      isolate(app, kind);
      return app.boardingTime();
    };
    const chair = await time('Aisle chair');
    expect(chair).toBeGreaterThan(await time('Reduced mobility'));
    expect(chair).toBeGreaterThan(await time('Own chair to the door'));
  });

  it('only asks how many crew when somebody needs carrying', async () => {
    const app = await launch();
    isolate(app, 'Reduced mobility');
    expect(() => app.slider('Crew per aisle chair')).toThrow();

    const chairs = await launch();
    isolate(chairs, 'Aisle chair');
    expect(() => chairs.slider('Crew per aisle chair')).not.toThrow();
  });

  it('costs more time the more crew each lift takes', async () => {
    const time = async (crew: number): Promise<number> => {
      const app = await launch();
      isolate(app, 'Aisle chair');
      app.drag(app.slider('Crew per aisle chair'), crew);
      return app.boardingTime();
    };
    expect(await time(3)).toBeGreaterThan(await time(1));
  });
});

describe('the run reports what assistance cost', () => {
  it('counts the transfers on the readout', async () => {
    const none = await launch();
    none.drag(none.slider('Needing assistance'), 0);
    none.boardingTime();
    expect(none.stat('Transfers')).toBe('0');

    const app = await launch();
    isolate(app, 'Aisle chair');
    app.boardingTime();
    expect(Number(app.stat('Transfers'))).toBeGreaterThan(0);
  });

  it('reports the wait for the crew to get back off', async () => {
    const app = await launch();
    isolate(app, 'Aisle chair');
    app.boardingTime();
    expect(app.stat('Crew hold')).toMatch(/^\d+:\d\d$/);
  });

  it('breaks the equity bands out by kind rather than lumping them', async () => {
    const app = await launch();
    app.layout();
    isolate(app, 'Aisle chair');
    app.boardingTime();
    // Charts only paint into a laid-out view, so ask for one and step again.
    app.$<HTMLButtonElement>('#step').click();
    const bands = app.$<HTMLElement>('#equity-bands').textContent ?? '';
    expect(bands).toContain('Aisle chair');
    expect(bands).not.toContain('Needs assistance');
  });
});
