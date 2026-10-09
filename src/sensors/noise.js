/** Standard normal sample (Box–Muller) from a uniform RNG. */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * First-order Gauss–Markov process: noise that wanders slowly instead of
 * jumping every sample. GPS position error behaves like this (it drifts over
 * tens of seconds), which plain white noise can't imitate.
 */
export class GaussMarkov {
  constructor(sigma, tau, rng) {
    this.sigma = sigma; // steady-state standard deviation
    this.tau = tau; // correlation time (s)
    this.rng = rng;
    this.value = 0;
  }

  step(dt, scale = 1) {
    const decay = Math.exp(-dt / this.tau);
    const drive = this.sigma * scale * Math.sqrt(1 - decay * decay);
    this.value = this.value * decay + drive * gaussian(this.rng);
    return this.value;
  }
}

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
