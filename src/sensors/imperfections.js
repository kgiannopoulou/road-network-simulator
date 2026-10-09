/**
 * Week 12: sensor imperfections.
 *
 * Each sensor has a datasheet (`spec`): its 1σ noise, typical latency and
 * dropout rate. The suite turns a few global knobs into per-sensor settings,
 * so "twice as noisy" means twice each sensor's own datasheet noise.
 *
 * Per-sensor settings (`sensor.imperfections`):
 *   noise        multiplier of the datasheet noise (0 = perfect)
 *   latency      seconds between sampling and delivery
 *   dropRate     probability that a measurement (or a single ray / point /
 *                target, for sensors that return many) is lost
 *   rangeScale   fraction of the nominal range the sensor still reaches
 *   failure      'none' | 'dead' | 'stuck' | 'intermittent'
 *   failureRate  random dead spells per minute (1–4 s each)
 */

export const FailureMode = { NONE: 'none', DEAD: 'dead', STUCK: 'stuck', INTERMITTENT: 'intermittent' };

export const PERFECT = Object.freeze({
  noise: 0,
  latency: 0,
  dropRate: 0,
  rangeScale: 1,
  failure: FailureMode.NONE,
  failureRate: 0,
});

/** Global knobs: multipliers of every sensor's datasheet values. */
export const PRESETS = {
  perfect: { noise: 0, latency: 0, drop: 0, range: 1, failureRate: 0, failures: {} },
  realistic: { noise: 1, latency: 1, drop: 1, range: 1, failureRate: 0, failures: {} },
  degraded: { noise: 3, latency: 4, drop: 5, range: 0.6, failureRate: 2, failures: { gps: FailureMode.INTERMITTENT } },
};

/** Per-sensor settings from the global knobs and the sensor's datasheet. */
export function imperfectionsFor(spec, knobs, failure = FailureMode.NONE) {
  return {
    noise: knobs.noise,
    latency: spec.latency * knobs.latency,
    dropRate: Math.min(1, spec.dropRate * knobs.drop),
    rangeScale: knobs.range,
    failure,
    failureRate: knobs.failureRate,
  };
}
