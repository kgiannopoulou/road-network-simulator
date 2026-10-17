import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fitnessSvg, toCsv, train } from '../../tools/train.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const quick = JSON.parse(read('configs/training/quick.json'));

describe('Reproducible training (tools/train.mjs)', () => {
  it('the same config gives the same metrics, generation by generation', () => {
    const a = train(quick);
    const b = train(quick);
    assert.equal(a.history.length, quick.generations);
    assert.deepEqual(a.history, b.history);
    assert.deepEqual(a.champion.brain, b.champion.brain);
  });

  it('reproduces the committed results/training/quick/metrics.csv exactly', () => {
    assert.equal(toCsv(train(quick).history), read('results/training/quick/metrics.csv').replace(/\r\n/g, '\n'));
  });

  it('a different seed is a different run', () => {
    const other = train({ ...quick, trainer: { ...quick.trainer, seed: 2 } });
    assert.notDeepEqual(other.history.map((h) => h.best), train(quick).history.map((h) => h.best));
  });

  it('writes a CSV row per generation and an SVG chart with both series', () => {
    const { history, events } = train(quick);
    const csv = toCsv(history).trim().split('\n');
    assert.equal(csv[0], 'generation,course,best,average,survival,reached,mutationRate');
    assert.equal(csv.length, quick.generations + 1);
    const svg = fitnessSvg(history, events, 'quick');
    assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.equal((svg.match(/<path d="M/g) ?? []).length, 2);
  });
});
