/**
 * Week 22: a fixed-time traffic signal controller.
 *
 * Approaches are grouped into phases: opposite arms share a phase, anything
 * left over gets its own. Each phase runs green → yellow → all-red, then the
 * next phase starts. Left turns on green are "permitted": the driver yields
 * to oncoming traffic (handled by the junction, not the lights).
 */
export const SIGNAL_TIMING = { green: 12, majorGreen: 16, yellow: 3, allRed: 1.5 };

export class SignalController {
  constructor(arms, { offset = 0, timing = SIGNAL_TIMING } = {}) {
    this.timing = timing;
    this.phases = SignalController.groupPhases(arms);
    this.durations = this.phases.map((p) => (p.major ? timing.majorGreen : timing.green));
    this.cycle = this.durations.reduce((sum, g) => sum + g + timing.yellow + timing.allRed, 0);
    this.time = (offset % 1) * this.cycle;
  }

  /** Opposite arms (within 30° of straight across) share a phase. */
  static groupPhases(arms) {
    const remaining = arms.filter((a) => a.inLanes > 0);
    const phases = [];
    while (remaining.length) {
      const a = remaining.shift();
      const group = [a];
      const j = remaining.findIndex((b) => Math.abs(Math.abs(wrap(a.angle - b.angle)) - Math.PI) < Math.PI / 6);
      if (j >= 0) group.push(...remaining.splice(j, 1));
      phases.push({ arms: group.map((x) => x.index), major: group.some((x) => x.major) });
    }
    return phases;
  }

  update(dt) {
    this.time = (this.time + dt) % this.cycle;
  }

  /** { phase, stage: 'green' | 'yellow' | 'red', remaining } of the active phase. */
  current() {
    let t = this.time;
    const { yellow, allRed } = this.timing;
    for (let i = 0; i < this.phases.length; i++) {
      const g = this.durations[i];
      if (t < g) return { phase: i, stage: 'green', remaining: g - t };
      t -= g;
      if (t < yellow) return { phase: i, stage: 'yellow', remaining: yellow - t };
      t -= yellow;
      if (t < allRed) return { phase: i, stage: 'red', remaining: allRed - t };
      t -= allRed;
    }
    return { phase: 0, stage: 'red', remaining: 0 };
  }

  /** True during the yellow and all-red after this arm's green (left-turners clear then). */
  clearing(armIndex) {
    const c = this.current();
    return this.phases[c.phase]?.arms.includes(armIndex) && c.stage !== 'green';
  }

  /** Light shown to an arm: 'green' | 'yellow' | 'red'. */
  state(armIndex) {
    const c = this.current();
    return this.phases[c.phase]?.arms.includes(armIndex) ? c.stage : 'red';
  }
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
