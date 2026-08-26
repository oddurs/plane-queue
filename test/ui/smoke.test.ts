// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { launch } from './harness.ts';

describe('the app boots', () => {
  it('renders a lane, a readout and a settings panel', async () => {
    const app = await launch();
    expect(app.laneNames()).toEqual(['Back to front']);
    expect(app.all('[data-picker="strategy"] .strategy').length).toBe(8);
    expect(app.picked('strategy')).toBe('Back to front');
    expect(app.picked('aircraft')).toBe('Airbus A320-200');
    expect(app.stat('Seated')).toMatch(/^\d+\/\d+$/);
    expect(app.masthead().strategy).toBe('Back to front');
  });

  it('runs a boarding to completion', async () => {
    const app = await launch();
    const seconds = app.boardingTime();
    expect(seconds).toBeGreaterThan(60);
    expect(app.stat('Seated')).toMatch(/^(\d+)\/\1$/);
  });
});
