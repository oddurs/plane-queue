import { STRATEGIES, naturalGroups } from '../engine/strategies.ts';
import { AIRCRAFT_TYPES } from '../engine/aircraft.ts';
import type { Scenario } from '../engine/run.ts';
import { ASSISTANCE_KINDS, type AssistanceKind, type StrategyId } from '../engine/types.ts';
import { DEFAULT_ASSISTANCE_MIX } from '../engine/passengers.ts';

/**
 * The settings panel. Plain DOM built from a small declarative spec — every
 * control writes into the Scenario and asks the app to rebuild the run.
 */

type Change = (mutate: (s: Scenario) => void) => void;

export interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  get: (s: Scenario) => number;
  set: (s: Scenario, v: number) => void;
  format: (v: number) => string;
  hint?: string;
  /**
   * Whether this control can do anything from where the scenario currently is.
   * A knob that cannot affect the run is noise, so it is not drawn at all.
   */
  applies?: (s: Scenario) => boolean;
}

const AIRCRAFT: SliderSpec[] = [
  {
    label: 'Rows',
    min: 8,
    max: 50,
    step: 1,
    get: (s) => s.cabin.rows,
    set: (s, v) => {
      s.cabin.rows = v;
      s.cabin.firstClassRows = Math.min(s.cabin.firstClassRows, v - 1);
    },
    format: (v) => `${v}`,
    hint: '30 rows ≈ A320 / 737-800',
  },
  {
    label: 'First-class rows',
    min: 0,
    max: 8,
    step: 1,
    get: (s) => s.cabin.firstClassRows,
    set: (s, v) => {
      s.cabin.firstClassRows = Math.min(v, s.cabin.rows - 1);
    },
    format: (v) => (v === 0 ? 'none' : `${v} (2-2)`),
  },
  {
    label: 'Load factor',
    min: 0.4,
    max: 1,
    step: 0.05,
    get: (s) => s.population.loadFactor,
    set: (s, v) => {
      s.population.loadFactor = v;
    },
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    label: 'Overhead slots per row',
    min: 3,
    max: 12,
    step: 1,
    get: (s) => s.cabin.binSlotsPerRow,
    set: (s, v) => {
      s.cabin.binSlotsPerRow = v;
    },
    format: (v) => `${v}`,
    hint: 'Below ~6 the bins run out and late boarders hunt for space',
  },
];

const PASSENGERS: SliderSpec[] = [
  {
    label: 'Carry-on bags per passenger',
    min: 0,
    max: 2.5,
    step: 0.1,
    get: (s) => s.population.meanBags,
    set: (s, v) => {
      s.population.meanBags = v;
    },
    format: (v) => v.toFixed(1),
    hint: 'The single biggest driver of total boarding time',
  },
  {
    label: 'Travelling in a party',
    min: 0,
    max: 0.9,
    step: 0.05,
    get: (s) => s.population.partyFraction,
    set: (s, v) => {
      s.population.partyFraction = v;
    },
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    label: 'Children within parties',
    applies: (s) => s.population.partyFraction > 0,
    min: 0,
    max: 0.8,
    step: 0.05,
    get: (s) => s.population.childFraction,
    set: (s, v) => {
      s.population.childFraction = v;
    },
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    label: 'Pace variation',
    min: 0,
    max: 0.5,
    step: 0.05,
    get: (s) => s.population.speedSpread,
    set: (s, v) => {
      s.population.speedSpread = v;
    },
    format: (v) => (v === 0 ? 'everyone alike' : `±${Math.round(v * 100)}%`),
    hint: 'Spread of individual walking pace. Changes who is quick and who dawdles without changing the average.',
  },
];

/** What each kind of assistance is called, and what it costs the aisle. */
const ASSISTANCE_LABELS: Record<Exclude<AssistanceKind, 'none'>, { name: string; hint: string }> = {
  'aisle-chair': {
    name: 'Aisle chair',
    hint: 'Carried to the seat by crew, who then walk back out through everyone still boarding. The only kind that puts extra people in the aisle.',
  },
  'own-wheelchair': {
    name: 'Own chair to the door',
    hint: 'Transfers at the aircraft door and walks or is steadied to the seat. No crew aboard.',
  },
  'reduced-mobility': {
    name: 'Reduced mobility',
    hint: 'Cane, walker, or simply slow on their feet. Preboards and boards unaided.',
  },
  minor: {
    name: 'Escorted minor',
    hint: 'Unaccompanied minor or an adult with an infant in arms.',
  },
};

/**
 * How the assisted share of the cabin divides between the four kinds.
 *
 * Relative weights rather than percentages that must sum to one, so dragging
 * one does not silently pull the others about. The readout shows the share each
 * weight currently works out to, which is the number anyone actually wants.
 */
const ASSISTANCE_MIX: SliderSpec[] = ASSISTANCE_KINDS.map((kind) => ({
  label: ASSISTANCE_LABELS[kind].name,
  applies: (s: Scenario) => s.population.assistanceFraction > 0,
  min: 0,
  max: 10,
  step: 1,
  get: (s: Scenario) => (s.population.assistanceMix ?? DEFAULT_ASSISTANCE_MIX)[kind],
  set: (s: Scenario, v: number) => {
    s.population.assistanceMix = {
      ...(s.population.assistanceMix ?? DEFAULT_ASSISTANCE_MIX),
      [kind]: v,
    };
  },
  format: () => '',
  hint: ASSISTANCE_LABELS[kind].hint,
}));

/** The crew side of it: how many people it takes to make the lift. */
const ASSISTANCE_CREW: SliderSpec[] = [
  {
    label: 'Needing assistance',
    min: 0,
    max: 0.15,
    step: 0.005,
    get: (s) => s.population.assistanceFraction,
    set: (s, v) => {
      s.population.assistanceFraction = v;
    },
    format: (v) => `${(v * 100).toFixed(1)}%`,
    hint: 'Share of the cabin who ask for help boarding, of any kind.',
  },
  {
    label: 'Crew per aisle chair',
    applies: (s) => assistedCount(s, 'aisle-chair') > 0,
    min: 1,
    max: 3,
    step: 1,
    get: (s) => s.params.escortsPerAisleChair,
    set: (s, v) => {
      s.params = { ...s.params, escortsPerAisleChair: v };
    },
    format: (v) => String(v),
    hint: 'Each of them walks back out against the boarding flow once the transfer is done.',
  },
];

/**
 * Roughly how many passengers a scenario will produce of one assistance kind.
 *
 * Only ever used to decide whether a control is worth drawing and what number
 * to print beside it, so an expected value from the weights is enough — the
 * actual manifest is drawn at random from the same distribution.
 */
export function assistedCount(s: Scenario, kind: Exclude<AssistanceKind, 'none'>): number {
  const seats = s.cabin.rows * 6 - s.cabin.firstClassRows * 2;
  const assisted = seats * s.population.loadFactor * s.population.assistanceFraction;
  const mix = s.population.assistanceMix ?? DEFAULT_ASSISTANCE_MIX;
  const total = ASSISTANCE_KINDS.reduce((sum, k) => sum + Math.max(0, mix[k]), 0);
  if (total <= 0) return 0;
  return Math.round((assisted * Math.max(0, mix[kind])) / total);
}

/**
 * Every continuous control the panel offers, so a test can sweep exactly the
 * range a user can reach rather than a hand-copied approximation of it.
 */
export const CONTROL_SPECS: SliderSpec[] = [
  ...AIRCRAFT,
  ...PASSENGERS,
  ...ASSISTANCE_CREW,
  ...ASSISTANCE_MIX,
];

/** The discrete controls, likewise. */
export const GATE_RANGES = {
  /** 13 on the slider means "strict order", i.e. no grouping. */
  releaseGroups: { min: 1, max: 13 },
  blocks: { min: 2, max: 12 },
} as const;

function sliders(
  specs: SliderSpec[],
  scenario: Scenario,
  onChange: Change,
  syncs: Sync[],
  /** Overrides the value readout, for controls whose number is a consequence. */
  readout?: (spec: SliderSpec) => string,
): HTMLElement[] {
  return specs
    .filter((spec) => spec.applies?.(scenario) ?? true)
    .map((spec) => slider(spec, scenario, onChange, syncs, readout));
}

/**
 * Says what the weights below it are weights *of*, and how many people that is.
 *
 * A relative weight means nothing on its own; the number worth reading is how
 * many passengers it works out to, and that moves whenever the load factor or
 * the assisted share does.
 */
function mixHeading(scenario: Scenario, syncs: Sync[]): HTMLElement {
  const hint = document.createElement('small');
  hint.className = 'hint';
  const paint = (): void => {
    const total = ASSISTANCE_KINDS.reduce((sum, k) => sum + assistedCount(scenario, k), 0);
    hint.textContent =
      total === 0
        ? 'Nobody aboard is asking for help.'
        : `How those ${total} passengers divide. Relative weights — the share beside each is what it works out to.`;
  };
  paint();
  syncs.push(paint);
  return hint;
}

/**
 * `3 · 40%` — the headcount this weight produces, and its share of the assisted.
 *
 * The share comes from the weights rather than from the rounded headcounts:
 * with only three assisted passengers aboard, every non-zero kind rounds to one
 * person, and a share derived from those would report an even split however the
 * sliders were actually set.
 */
function shareLabel(scenario: Scenario, kind: Exclude<AssistanceKind, 'none'>): string {
  const mix = scenario.population.assistanceMix ?? DEFAULT_ASSISTANCE_MIX;
  const weight = Math.max(0, mix[kind]);
  const total = ASSISTANCE_KINDS.reduce((sum, k) => sum + Math.max(0, mix[k]), 0);
  if (total === 0) return '0';
  return `${assistedCount(scenario, kind)} · ${Math.round((weight / total) * 100)}%`;
}

function slider(
  spec: SliderSpec,
  scenario: Scenario,
  onChange: Change,
  syncs: Sync[],
  readout?: (spec: SliderSpec) => string,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';

  const head = document.createElement('span');
  head.className = 'field-head';
  const name = document.createElement('span');
  name.textContent = spec.label;
  const value = document.createElement('output');
  const show = (v: number): string => readout?.(spec) ?? spec.format(v);
  value.textContent = show(spec.get(scenario));
  head.append(name, value);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.get(scenario));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    onChange((s) => spec.set(s, v));
    // After the change, not before: a share is a consequence of the new value.
    value.textContent = show(v);
  });

  // One control can move another — dragging Rows down clamps first-class rows.
  // Re-reading from the scenario keeps them honest without rebuilding the panel.
  syncs.push(() => {
    const v = spec.get(scenario);
    input.value = String(v);
    value.textContent = show(v);
  });

  wrap.append(head, input);
  if (spec.hint) {
    const hint = document.createElement('small');
    hint.textContent = spec.hint;
    wrap.append(hint);
  }
  return wrap;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const el = document.createElement('section');
  el.className = 'control-group';
  const h = document.createElement('h2');
  h.textContent = title;
  el.append(h, ...children);
  return el;
}

function checkbox(
  label: string,
  checked: boolean,
  hint: string,
  onToggle: (v: boolean) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field check-field';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onToggle(input.checked));
  const text = document.createElement('span');
  text.textContent = label;
  const row = document.createElement('span');
  row.className = 'check-row';
  row.append(input, text);
  const small = document.createElement('small');
  small.textContent = hint;
  wrap.append(row, small);
  return wrap;
}

type Sync = () => void;

/**
 * Draws the panel and returns a function that refreshes every control's value
 * in place.
 *
 * The panel used to be rebuilt on every change, which meant the first `input`
 * event of a slider drag replaced the element being dragged and the browser
 * dropped the gesture — sliders could only be moved by the keyboard. Values are
 * synced instead, and the structure is only rebuilt when the set of visible
 * controls actually changes.
 */
export function buildControls(
  host: HTMLElement,
  scenario: Scenario,
  onChange: Change,
): Sync {
  host.replaceChildren();
  const syncs: Sync[] = [];

  // Strategy picker. Eight blurb cards were most of the sidebar's weight, so
  // only the selected strategy explains itself.
  const picker = document.createElement('div');
  picker.className = 'strategy-list';
  // The aircraft picker below borrows this list's styling, so the two are
  // told apart by what they choose rather than by how they look.
  picker.dataset.picker = 'strategy';
  for (const meta of STRATEGIES) {
    const btn = document.createElement('button');
    btn.className = 'strategy' + (meta.id === scenario.boarding.strategy ? ' active' : '');
    btn.textContent = meta.name;
    btn.addEventListener('click', () => {
      onChange((s) => {
        s.boarding.strategy = meta.id as StrategyId;
        // Move the enforcement knob to whatever this method realistically implies.
        s.boarding.releaseGroups = naturalGroups(meta.id, { blocks: s.boarding.blocks });
      });
    });
    picker.append(btn);
  }

  const blurb = document.createElement('p');
  blurb.className = 'strategy-blurb';
  blurb.textContent =
    STRATEGIES.find((s) => s.id === scenario.boarding.strategy)?.blurb ??
    'A policy found by the optimizer.';

  host.append(section('Strategy', [picker, blurb]));

  // Gate discipline.
  const gate: HTMLElement[] = [];

  const strict = scenario.boarding.releaseGroups === null;
  const groupsField = document.createElement('label');
  groupsField.className = 'field';
  const gHead = document.createElement('span');
  gHead.className = 'field-head';
  const gName = document.createElement('span');
  gName.textContent = 'Gate release groups';
  const gValue = document.createElement('output');
  gValue.textContent = strict ? 'strict order' : String(scenario.boarding.releaseGroups);
  gHead.append(gName, gValue);

  const gInput = document.createElement('input');
  gInput.type = 'range';
  gInput.min = '1';
  gInput.max = '13';
  gInput.step = '1';
  // 13 is the top of the scale and means "no grouping at all".
  gInput.value = strict ? '13' : String(Math.min(12, scenario.boarding.releaseGroups ?? 4));
  gInput.addEventListener('input', () => {
    const v = Number(gInput.value);
    const groups = v >= 13 ? null : v;
    gValue.textContent = groups === null ? 'strict order' : String(groups);
    onChange((s) => {
      s.boarding.releaseGroups = groups;
    });
  });
  const gHint = document.createElement('small');
  gHint.textContent =
    'Order is only enforced between groups, never inside one. 1 group turns any strategy into random boarding; strict order needs a numbered queue at the gate.';
  syncs.push(() => {
    const groups = scenario.boarding.releaseGroups;
    gInput.value = groups === null ? '13' : String(Math.min(12, groups));
    gValue.textContent = groups === null ? 'strict order' : String(groups);
  });
  groupsField.append(gHead, gInput, gHint);
  gate.push(groupsField);

  // Only three of the eight strategies divide the cabin into blocks; for the
  // rest this slider does nothing at all, so it is not shown.
  const usesBlocks = ['back-to-front', 'front-to-back', 'reverse-pyramid'].includes(
    scenario.boarding.strategy,
  );
  if (usesBlocks) {
    gate.push(
      slider(
        {
          label: 'Blocks',
          min: 2,
          max: 12,
          step: 1,
          get: (s) => s.boarding.blocks,
          set: (s, v) => {
            s.boarding.blocks = v;
          },
          format: (v) => `${v}`,
        },
        scenario,
        onChange,
        syncs,
      ),
    );
  }

  if (scenario.population.assistanceFraction > 0) {
    gate.push(
      checkbox(
        'Preboard passengers needing assistance',
        scenario.boarding.preboardAssistance,
        'Boards them, and anyone travelling with them, ahead of everyone else.',
        (v) =>
          onChange((s) => {
            s.boarding.preboardAssistance = v;
          }),
      ),
    );
  }

  gate.push(
    checkbox(
      'Gate-check bags when bins fill',
      scenario.params.gateCheckWhenFull,
      'Once the cabin cannot take any more carry-on, the last groups called have their bags tagged at the desk. Caps how bad a bag-heavy flight can get.',
      (v) =>
        onChange((s) => {
          s.params = { ...s.params, gateCheckWhenFull: v };
        }),
    ),
  );

  if (scenario.population.partyFraction > 0) {
    gate.push(
      checkbox(
        'Families board together',
        scenario.boarding.familiesBoardTogether,
        'Parties queue as one unit. This is the practical objection to Steffen’s method — it deliberately separates neighbouring seats in line.',
        (v) =>
          onChange((s) => {
            s.boarding.familiesBoardTogether = v;
          }),
      ),
    );
  }

  host.append(section('Gate', gate));
  // Type first: it sets the pitch, cross section and exit stations everything
  // else is drawn and timed against.
  const typePicker = document.createElement('div');
  typePicker.className = 'strategy-list';
  typePicker.dataset.picker = 'aircraft';
  for (const type of AIRCRAFT_TYPES) {
    const btn = document.createElement('button');
    btn.className = 'strategy' + (type.id === (scenario.cabin.typeId ?? 'a320') ? ' active' : '');
    btn.textContent = type.name;
    btn.addEventListener('click', () =>
      onChange((s) => {
        s.cabin.typeId = type.id;
      }),
    );
    typePicker.append(btn);
  }
  const provenance = document.createElement('p');
  provenance.className = 'strategy-blurb';
  provenance.textContent =
    AIRCRAFT_TYPES.find((t) => t.id === (scenario.cabin.typeId ?? 'a320'))?.source ?? '';

  host.append(
    section('Aircraft', [
      typePicker,
      provenance,
      ...sliders(AIRCRAFT, scenario, onChange, syncs),
    ]),
  );
  host.append(section('Passengers', sliders(PASSENGERS, scenario, onChange, syncs)));

  // Mobility assistance. Its own section because the aisle-chair case is not a
  // slower passenger — it puts crew in the aisle who then have to get back out.
  const assistance: HTMLElement[] = sliders(ASSISTANCE_CREW, scenario, onChange, syncs);
  if (scenario.population.assistanceFraction > 0) {
    assistance.push(mixHeading(scenario, syncs));
    assistance.push(...sliders(ASSISTANCE_MIX, scenario, onChange, syncs, (spec) => {
      const kind = ASSISTANCE_KINDS.find((k) => ASSISTANCE_LABELS[k].name === spec.label);
      return kind ? shareLabel(scenario, kind) : '';
    }));
  }
  host.append(section('Mobility assistance', assistance));

  // Seed.
  const seedField = document.createElement('label');
  seedField.className = 'field';
  const sHead = document.createElement('span');
  sHead.className = 'field-head';
  sHead.innerHTML = '<span>Value</span>';
  const seedInput = document.createElement('input');
  seedInput.type = 'number';
  seedInput.value = String(scenario.seed);
  seedInput.min = '1';
  seedInput.addEventListener('change', () =>
    onChange((s) => {
      s.seed = Math.max(1, Number(seedInput.value) || 1);
    }),
  );
  const seedHint = document.createElement('small');
  seedHint.textContent = 'Same seed, same passengers — so switching strategy is a fair test.';
  seedField.append(sHead, seedInput, seedHint);
  host.append(section('Seed', [seedField]));

  return () => {
    for (const sync of syncs) sync();
    seedInput.value = String(scenario.seed);
  };
}
