// Headless, reproducible training run: the same TrainingSession the browser
// uses (main thread or Web Worker), driven from a JSON config in Node.
//
//   node tools/train.mjs configs/training/baseline.json
//   node tools/train.mjs configs/training/quick.json --out /tmp/run
//   node tools/train.mjs configs/training/sharp-wide.json --seed 2
//
// Writes to results/training/<name>/ (or --out):
//   metrics.csv     one row per generation: best, average, survival, reached…
//   metrics.json    the config, the per-generation history, course changes,
//                   the champion's score and the run time
//   fitness.svg     best and average fitness per generation, course changes
//   champion.json   the best brain (network weights), loadable in the app
//
// Training is deterministic for a given config (seeded RNG, fixed 1/60 s
// steps, no sensor noise unless the config asks for it), so the same config
// produces the same metrics on any machine. tests/unit/train-cli.test.js
// checks that.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrainingSession } from '../src/training/session.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a config to completion; returns { history, events, champion, steps, seconds }. */
export function train(config, { onGeneration } = {}) {
  const { generations = 30, name: _name, description: _description, ...sessionConfig } = config;
  const session = new TrainingSession(sessionConfig).start();
  const started = performance.now();
  let reported = 0;
  while (session.trainer.generation < generations) {
    session.step();
    if (session.trainer.history.length > reported) {
      reported = session.trainer.history.length;
      onGeneration?.(session.trainer.history.at(-1), session);
    }
  }
  const champion = session.trainer.champion;
  return {
    history: session.trainer.history.map((h) => ({ ...h })),
    events: session.events.map((e) => ({ ...e })),
    champion: champion ? { fitness: champion.fitness, generation: champion.generation, course: champion.course, rank: champion.rank, brain: champion.brain } : null,
    steps: session.trainer.steps,
    seconds: (performance.now() - started) / 1000,
  };
}

const COLUMNS = ['generation', 'course', 'best', 'average', 'survival', 'reached', 'mutationRate'];

export function toCsv(history) {
  const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v ?? ''));
  return [COLUMNS.join(','), ...history.map((h) => COLUMNS.map((c) => fmt(h[c])).join(','))].join('\n') + '\n';
}

/** A small, dependency-free SVG line chart of best and average fitness. */
export function fitnessSvg(history, events, title) {
  const W = 760;
  const H = 360;
  const pad = { l: 64, r: 20, t: 44, b: 48 };
  const n = history.length;
  const values = history.flatMap((h) => [h.best, h.average]);
  const step = niceStep((Math.max(1, ...values) - Math.min(0, ...values)) / 5);
  const maxY = Math.ceil(Math.max(1, ...values) / step) * step;
  const minY = Math.floor(Math.min(0, ...values) / step) * step;
  const x = (g) => pad.l + ((W - pad.l - pad.r) * g) / Math.max(1, n - 1);
  const y = (v) => H - pad.b - ((H - pad.t - pad.b) * (v - minY)) / (maxY - minY);
  const line = (key) => history.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h[key]).toFixed(1)}`).join(' ');
  const ticks = Array.from({ length: Math.round((maxY - minY) / step) + 1 }, (_, i) => minY + step * i);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const xStep = niceStep(Math.max(1, n - 1) / 6);
  const xTicks = Array.from({ length: Math.floor((n - 1) / xStep) + 1 }, (_, i) => i * xStep);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${pad.l}" y="22" font-size="15" font-weight="600" fill="#1f2328">${esc(title)}</text>
  <g stroke="#e6e8eb">${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')}</g>
  <g fill="#656d76" text-anchor="end">${ticks.map((v) => `<text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}">${Math.round(v)}</text>`).join('')}</g>
  <g fill="#656d76" text-anchor="middle">${xTicks.map((g) => `<text x="${x(g).toFixed(1)}" y="${H - pad.b + 18}">${g}</text>`).join('')}</g>
  <text x="${(pad.l + W - pad.r) / 2}" y="${H - 10}" text-anchor="middle" fill="#656d76">generation</text>
  <text transform="translate(16 ${(pad.t + H - pad.b) / 2}) rotate(-90)" text-anchor="middle" fill="#656d76">fitness</text>
  <g stroke="#8c959f" stroke-dasharray="3 4">${events
    .filter((e) => e.generation > 0 && e.generation < n)
    .map((e) => `<line x1="${x(e.generation).toFixed(1)}" x2="${x(e.generation).toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>`)
    .join('')}</g>
  <g fill="#656d76" font-size="11">${events
    .filter((e) => e.generation < n)
    .map((e) => `<text x="${(x(e.generation) + 4).toFixed(1)}" y="${pad.t + 12}">${esc(e.course)}</text>`)
    .join('')}</g>
  <path d="${line('average')}" fill="none" stroke="#9a6700" stroke-width="2"/>
  <path d="${line('best')}" fill="none" stroke="#0969da" stroke-width="2.5"/>
  <g transform="translate(${W - pad.r - 170} ${pad.t - 26})">
    <line x1="0" x2="18" y1="0" y2="0" stroke="#0969da" stroke-width="2.5"/><text x="24" y="4" fill="#1f2328">best</text>
    <line x1="74" x2="92" y1="0" y2="0" stroke="#9a6700" stroke-width="2"/><text x="98" y="4" fill="#1f2328">average</text>
  </g>
</svg>
`;
}

/** 1, 2, 5, 10, 20, 50… at or above `raw`. */
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw);
}

// ---- CLI ---------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/train.mjs <config.json> [--out dir]');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const seedFlag = process.argv.indexOf('--seed');
  if (seedFlag > 0) config.trainer = { ...config.trainer, seed: Number(process.argv[seedFlag + 1]) };
  const name = config.name ?? basename(file, '.json');
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag > 0 ? resolve(process.argv[outFlag + 1]) : join(ROOT, 'results', 'training', name);
  mkdirSync(out, { recursive: true });

  console.log(`${name}: ${config.generations ?? 30} generations, population ${config.trainer?.populationSize ?? 150}, seed ${config.trainer?.seed ?? 1}`);
  const result = train(config, {
    onGeneration: (h) =>
      console.log(
        `  gen ${String(h.generation).padStart(3)}  ${String(h.course).padEnd(10)} best ${h.best.toFixed(1).padStart(8)}  avg ${h.average.toFixed(1).padStart(8)}  reached ${(h.reached * 100).toFixed(0).padStart(3)}%`,
      ),
  });

  writeFileSync(join(out, 'metrics.csv'), toCsv(result.history));
  writeFileSync(
    join(out, 'metrics.json'),
    JSON.stringify(
      {
        name,
        config,
        node: process.version,
        steps: result.steps,
        seconds: Math.round(result.seconds * 10) / 10,
        champion: result.champion && { fitness: result.champion.fitness, generation: result.champion.generation, course: result.champion.course },
        events: result.events,
        history: result.history,
      },
      null,
      2,
    ) + '\n',
  );
  if (result.champion) writeFileSync(join(out, 'champion.json'), JSON.stringify(result.champion, null, 2) + '\n');
  writeFileSync(join(out, 'fitness.svg'), fitnessSvg(result.history, result.events, `${name}: best and average fitness (seed ${config.trainer?.seed ?? 1})`));
  console.log(`\n${result.steps} steps in ${result.seconds.toFixed(1)} s → ${out}`);
}
