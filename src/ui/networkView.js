import { OUTPUT_LABELS } from '../ai/brain.js';

const POSITIVE = [57, 135, 229]; // blue
const NEGATIVE = [217, 89, 38]; // orange

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;
const signed = (v, alpha) => rgba(v >= 0 ? POSITIVE : NEGATIVE, alpha);

/**
 * Draws a brain as layers of neurons, inputs on the left. Connections are
 * blue for positive and orange for negative weights, more opaque the larger
 * the weight; each neuron is filled with its current activation the same way.
 */
export function drawNetwork(canvas, brain) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, w, h);
  if (!brain) {
    ctx.fillStyle = '#9aa4ad';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('No brain yet: start training', 12, h / 2);
    return;
  }

  const net = brain.network;
  const left = 54;
  const right = w - 96;
  const top = 12;
  const bottom = h - 12;
  const columns = net.sizes.length;
  const x = (k) => left + ((right - left) * k) / (columns - 1);
  const y = (k, i) => {
    const n = net.sizes[k];
    return n === 1 ? (top + bottom) / 2 : top + ((bottom - top) * i) / (n - 1);
  };
  const values = [brain.lastInputs, ...net.layers.map((l) => l.outputs)];

  // Connections.
  net.layers.forEach((layer, k) => {
    for (let j = 0; j < layer.outputCount; j++) {
      for (let i = 0; i < layer.inputCount; i++) {
        const weight = layer.weights[j][i];
        ctx.beginPath();
        ctx.moveTo(x(k), y(k, i));
        ctx.lineTo(x(k + 1), y(k + 1, j));
        ctx.strokeStyle = signed(weight, Math.min(0.9, Math.abs(weight) * 0.6));
        ctx.lineWidth = 0.5 + Math.min(2, Math.abs(weight));
        ctx.stroke();
      }
    }
  });

  // Neurons.
  const radius = Math.min(9, (bottom - top) / (Math.max(...net.sizes) * 2.4));
  net.sizes.forEach((n, k) => {
    for (let i = 0; i < n; i++) {
      const v = values[k]?.[i] ?? 0;
      ctx.beginPath();
      ctx.arc(x(k), y(k, i), radius, 0, Math.PI * 2);
      ctx.fillStyle = '#0b0f14';
      ctx.fill();
      ctx.fillStyle = signed(v, Math.min(1, Math.abs(v)));
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (k > 0) {
        // Bias as a small ring.
        const bias = net.layers[k - 1].biases[i];
        ctx.beginPath();
        ctx.arc(x(k), y(k, i), radius + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = signed(bias, Math.min(0.9, Math.abs(bias) * 0.7));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  });

  // Labels in text colours; the neuron fill carries the value.
  ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#9aa4ad';
  ctx.textAlign = 'right';
  brain.inputLabels.forEach((label, i) => ctx.fillText(label, left - radius - 5, y(0, i)));
  ctx.textAlign = 'left';
  const last = columns - 1;
  OUTPUT_LABELS.forEach((label, i) => {
    const v = values[last]?.[i] ?? 0;
    ctx.fillStyle = '#e6e9ec';
    ctx.fillText(`${label} ${v >= 0 ? ' ' : ''}${v.toFixed(2)}`, right + radius + 5, y(last, i));
  });
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}
