/**
 * Week 20: simulation speed. Training always advances in fixed 1/60 s steps,
 * so speed only changes how many steps run per second of real time:
 *
 *   1×, 2×, 5×, 10×, 50×   that many seconds of simulation per real second
 *   'max'                  as many steps as fit in each time slice
 */
export const SPEEDS = [1, 2, 5, 10, 50, 'max'];
export const STEPS_PER_SECOND = 60;
export const MAX_SLICE_MS = 40; // longest uninterrupted burst of simulation

/**
 * Steps owed after `elapsed` real seconds. Fractions carry over; a backlog
 * (the tab was hidden, the machine is too slow) is dropped instead of
 * snowballing. 'max' is limited only by the time slice.
 */
export function stepsDue(speed, elapsed, carry = 0) {
  if (speed === 'max') return { due: Infinity, carry: 0 };
  const exact = carry + elapsed * STEPS_PER_SECOND * speed;
  const cap = Math.max(1, STEPS_PER_SECOND * speed * 0.25);
  const due = Math.min(Math.floor(exact), cap);
  return { due, carry: due === cap ? 0 : exact - due };
}

/** Runs a session's steps with a time budget, measuring throughput. */
export class StepMeter {
  constructor() {
    this.windowSteps = 0;
    this.windowTime = 0;
    this.stepsPerSecond = 0;
  }

  add(steps, seconds) {
    this.windowSteps += steps;
    this.windowTime += seconds;
    if (this.windowTime >= 0.5) {
      this.stepsPerSecond = this.windowSteps / this.windowTime;
      this.windowSteps = 0;
      this.windowTime = 0;
    }
  }
}
