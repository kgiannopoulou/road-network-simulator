/**
 * Activation functions, looked up by name so a network can be serialised as
 * plain JSON. Outputs of `tanh` lie in (−1, 1), which maps naturally onto
 * steering; `sigmoid` gives (0, 1).
 */
export const ACTIVATIONS = {
  tanh: Math.tanh,
  sigmoid: (x) => 1 / (1 + Math.exp(-x)),
  relu: (x) => (x > 0 ? x : 0),
  leakyRelu: (x) => (x > 0 ? x : 0.01 * x),
  step: (x) => (x > 0 ? 1 : 0),
  linear: (x) => x,
};

export function activation(name) {
  const fn = ACTIVATIONS[name];
  if (!fn) throw new Error(`Unknown activation "${name}"`);
  return fn;
}
