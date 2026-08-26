import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

/**
 * Boots the real app — the shipped `index.html` and `main.ts` — into a DOM and
 * hands back the handles a person would use.
 *
 * Everything below the app shell was already covered: the engine has its own
 * suite, and the strategies are checked queue by queue. What nothing tested was
 * the wiring in between, which is where the failures people actually notice
 * live — a control that changes the scenario but not the simulation, a readout
 * that keeps a stale number, a picker whose selection never reaches the run.
 * So the assertions here are deliberately made against what the screen shows,
 * never against module internals.
 */

// Under a DOM environment `import.meta.url` is an http URL, so the shipped
// markup is read relative to the project root vitest runs from.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/**
 * A no-op 2D context.
 *
 * The cabin renderer refuses to construct without one and the app builds a
 * renderer per lane, but nothing here asserts on pixels — the canvas is the one
 * surface a DOM test cannot read anyway.
 */
function stubCanvas(): void {
  const context = new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 0 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      createLinearGradient: () => ({ addColorStop() {} }),
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        key in target ? target[key as string] : () => undefined,
      set: () => true,
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => context) as never;
}

/**
 * The bench persists pins through `localStorage`, which this DOM environment
 * does not provide. Without it the app degrades quietly — every read fails and
 * the bench is simply always empty — which would make a pinning test pass for
 * the wrong reason.
 */
function stubStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

let layoutWidth = 0;

export interface App {
  /** Click a control the way a mouse would: pointerdown, pointerup, click. */
  click(el: Element): void;
  /** Drag a range input to `value`, firing the events a real drag fires. */
  drag(input: HTMLInputElement, value: number): void;
  /** Set a select and fire `change`, as a user picking an option would. */
  select(el: HTMLSelectElement, value: string): void;
  /** Type into a text or number field and commit it, as tabbing away would. */
  type(el: HTMLInputElement, value: string | number): void;
  $<T extends Element>(selector: string): T;
  all<T extends Element>(selector: string): T[];
  /** The label above each lane — the strategy the lane says it is running. */
  laneNames(): string[];
  /** One readout value, by the label printed beside it. */
  stat(label: string, lane?: number): string;
  /**
   * A lane's whole readout as one string.
   *
   * Comparing this across a change is the general test for "did this control
   * reach the simulation at all" — eight statistics coinciding by chance is far
   * less likely than any one of them doing so.
   */
  readout(lane?: number): string;
  /** Runs lane 0 to the end and returns its boarding time in simulated seconds. */
  boardingTime(): number;
  /** A button in one of the sidebar pickers, by visible name. */
  pick(picker: 'strategy' | 'aircraft', name: string): HTMLButtonElement;
  /** The name shown as selected in a picker. */
  picked(picker: 'strategy' | 'aircraft'): string;
  /** Every range input in the settings panel, keyed by its visible label. */
  slider(label: string): HTMLInputElement;
  /** A settings-panel checkbox, by the label printed beside it. */
  toggle(label: string): HTMLInputElement;
  masthead(): Record<string, string>;
  /**
   * Gives every element a width so the charts paint.
   *
   * Off by default: the app repaints its SVGs on every forced draw, and a full
   * boarding is several hundred of those.
   */
  layout(width?: number): void;
}

export async function launch(): Promise<App> {
  // The module script is imported directly below; leaving the tag in makes the
  // DOM try to fetch it over HTTP and log a failure that means nothing here.
  const body = html
    .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
    .replace(/<script\b[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  stubCanvas();
  stubStorage();

  // Nothing has a layout here, so every element measures zero — which the app
  // already treats as "not on screen yet" and skips painting charts into.
  // That is the fast default; `app.layout()` opts a test into chart painting.
  layoutWidth = 0;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => layoutWidth,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });

  // main.ts owns the scenario in module scope and wires itself up on import,
  // so every test needs a genuinely fresh copy of it.
  vi.resetModules();
  await import('../../src/main.ts');

  const $ = <T extends Element>(selector: string): T => {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    return el;
  };
  const all = <T extends Element>(selector: string): T[] => [
    ...document.querySelectorAll<T>(selector),
  ];

  const fire = (el: Element, type: string): void => {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  };

  const app: App = {
    $,
    all,
    click(el) {
      // The settings panel defers structural rebuilds while a pointer is down,
      // so a click that skips the pointer events exercises a path no user hits.
      fire(el, 'pointerdown');
      fire(el, 'pointerup');
      (el as HTMLElement).click();
    },
    drag(input, value) {
      fire(input, 'pointerdown');
      input.value = String(value);
      fire(input, 'input');
      fire(input, 'pointerup');
    },
    select(el, value) {
      el.value = value;
      fire(el, 'change');
    },
    type(el, value) {
      el.value = String(value);
      fire(el, 'input');
      fire(el, 'change');
    },
    laneNames: () => all<HTMLElement>('.lane-name').map((el) => el.textContent ?? ''),
    stat(label, lane = 0) {
      const readout = all<HTMLElement>('.readout')[lane];
      if (!readout) throw new Error(`no lane ${lane}`);
      const cell = [...readout.querySelectorAll('.stat')].find(
        (el) => el.querySelector('span')?.textContent === label,
      );
      if (!cell) throw new Error(`no stat "${label}"`);
      return cell.querySelector('strong')?.textContent ?? '';
    },
    readout(lane = 0) {
      const el = all<HTMLElement>('.readout')[lane];
      if (!el) throw new Error(`no lane ${lane}`);
      return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    },
    boardingTime() {
      const step = $<HTMLButtonElement>('#step');
      const time = $<HTMLElement>('.lane-time');
      for (let i = 0; i < 4000; i++) {
        if (time.classList.contains('finished')) break;
        step.click();
      }
      if (!time.classList.contains('finished')) throw new Error('lane never finished');
      return parseClock(time.textContent ?? '');
    },
    pick(picker, name) {
      const btn = all<HTMLButtonElement>(`[data-picker="${picker}"] .strategy`).find(
        (b) => b.textContent === name,
      );
      if (!btn) throw new Error(`no ${picker} button "${name}"`);
      return btn;
    },
    picked(picker) {
      return $<HTMLElement>(`[data-picker="${picker}"] .strategy.active`).textContent ?? '';
    },
    slider(label) {
      const input = all<HTMLInputElement>('#controls input[type=range]').find((el) =>
        (el.closest('.field')?.querySelector('.field-head')?.textContent ?? '').includes(
          label,
        ),
      );
      if (!input) throw new Error(`no slider "${label}"`);
      return input;
    },
    layout(width = 800) {
      layoutWidth = width;
    },
    toggle(label) {
      const field = all<HTMLElement>('#controls .field, #controls label').find((el) =>
        (el.textContent ?? '').startsWith(label),
      );
      const input = field?.querySelector<HTMLInputElement>('input[type=checkbox]');
      if (!input) throw new Error(`no toggle "${label}"`);
      return input;
    },
    masthead() {
      const out: Record<string, string> = {};
      for (const row of all<HTMLElement>('#masthead-meta > div')) {
        const key = row.querySelector('dt')?.textContent ?? '';
        out[key] = row.querySelector('dd')?.textContent ?? '';
      }
      return out;
    },
  };

  return app;
}

/** `m:ss` back to seconds. */
export function parseClock(text: string): number {
  const [m, s] = text.split(':');
  return Number(m) * 60 + Number(s);
}
