import { clearChampion, loadChampion, saveChampion } from '../ai/championStore.js';
import { TRAINER_DEFAULTS } from '../ai/trainer.js';
import { FitnessChart } from './fitnessChart.js';
import { drawNetwork } from './networkView.js';

/** Settings that only apply when a run (re)starts. */
const START_FIELDS = ['populationSize', 'hidden', 'generationTime', 'sensorNoise', 'fromCar', 'continueChampion'];
/** GA settings that can change while training. */
const LIVE_FIELDS = ['mutationRate', 'mutationAmount', 'elitism', 'tournamentSize', 'crossoverRate', 'generationTime'];

/**
 * Training panel: start/stop a run, its settings, live stats, the leader's
 * brain, the fitness history and the champion (saved to localStorage
 * automatically whenever it improves).
 */
export class TrainingPanel {
  constructor(panel, sim, { onAutopilot } = {}) {
    this.panel = panel;
    this.sim = sim;
    this.onAutopilot = onAutopilot;
    this.speed = 1;
    this.timer = 0;
    this.drawnHistory = -1;
    this.champion = loadChampion();
    this.message = '';

    this.networkCanvas = panel.querySelector('#network-view');
    this.chart = new FitnessChart(panel.querySelector('#fitness-chart'), panel.querySelector('#fitness-legend'));
    this.field = (name) => panel.querySelector(`[data-train="${name}"]`);
    this.#bind();
    this.#refreshChampion();
    this.chart.draw([]);
  }

  get visible() {
    return !this.panel.hidden;
  }

  show(visible) {
    this.panel.hidden = !visible;
  }

  #bind() {
    for (const el of this.panel.querySelectorAll('[data-train]')) {
      const out = this.panel.querySelector(`[data-out="train-${el.dataset.train}"]`);
      const sync = () => {
        if (out) out.textContent = el.value;
        if (LIVE_FIELDS.includes(el.dataset.train) && this.sim.trainer) {
          Object.assign(this.sim.trainer.options, this.#config());
        }
      };
      el.addEventListener('input', sync);
      sync();
    }
    this.panel.querySelector('[data-train-action="start"]').addEventListener('click', () => this.start());
    this.panel.querySelector('[data-train-action="next"]').addEventListener('click', () => this.sim.trainer?.nextGeneration());
    this.panel.querySelector('[data-train-action="stop"]').addEventListener('click', () => this.stop());
    this.panel.querySelector('[data-train-action="forget"]').addEventListener('click', () => this.forgetChampion());
    this.panel.querySelector('[data-train-action="autopilot"]').addEventListener('click', () => this.onAutopilot?.());
    this.panel.querySelector('[data-train="speed"]').addEventListener('change', (e) => (this.speed = Number(e.target.value)));
  }

  #config() {
    const num = (name) => Number(this.field(name).value);
    return {
      populationSize: num('populationSize'),
      hidden: [num('hidden')],
      generationTime: num('generationTime'),
      mutationRate: num('mutationRate'),
      mutationAmount: num('mutationAmount'),
      elitism: num('elitism'),
      tournamentSize: num('tournamentSize'),
      crossoverRate: num('crossoverRate'),
      sensorNoise: this.field('sensorNoise').checked,
    };
  }

  start() {
    const config = this.#config();
    const options = { ...TRAINER_DEFAULTS, ...config, seed: Math.floor(Math.random() * 1e9) };
    if (this.field('fromCar').checked) {
      const s = this.sim.player.state;
      options.spawn = { x: s.x, y: s.y, angle: s.angle };
    }
    const seed = this.field('continueChampion').checked ? this.champion : null;
    this.message = '';
    try {
      this.sim.startTraining({ ...options, champion: seed });
    } catch (err) {
      // A champion with a different network layout can't seed this run.
      this.message = `${err.message}. Started from scratch.`;
      this.sim.startTraining(options);
    }
    if (!this.sim.trainer) this.message = 'Build some roads first.';
    this.drawnHistory = -1;
  }

  stop() {
    this.sim.stopTraining();
  }

  forgetChampion() {
    clearChampion();
    this.champion = null;
    if (this.sim.trainer) this.sim.trainer.champion = null;
    this.#refreshChampion();
  }

  /** Runs every frame, visible or not, so a new champion is always saved. */
  update(rawDelta) {
    const trainer = this.sim.trainer;
    if (trainer?.championChanged) {
      trainer.championChanged = false;
      this.champion = trainer.champion;
      saveChampion(this.champion);
      this.#refreshChampion();
    }
    if (!this.visible) return;

    const leader = trainer?.leader;
    drawNetwork(this.networkCanvas, leader?.brain ?? null);

    this.timer += rawDelta;
    if (this.timer < 0.2) return;
    this.timer = 0;

    const stats = this.panel.querySelector('[data-train-stats]');
    if (trainer) {
      const s = trainer.stats();
      stats.innerHTML = `
        <div><b>Generation ${s.generation}</b> · ${s.time.toFixed(0)} / ${trainer.options.generationTime} s</div>
        <div>Alive ${s.alive} / ${s.total} · crashed ${s.crashed} · stalled ${s.stalled}</div>
        <div>Leader ${s.leaderFitness.toFixed(0)} m · champion ${s.champion.toFixed(0)} m</div>`;
    } else {
      stats.innerHTML = `<div>${this.message || 'Not training. Press <b>Start</b>.'}</div>`;
    }
    const history = trainer?.history ?? [];
    if (history.length !== this.drawnHistory) {
      this.drawnHistory = history.length;
      this.chart.draw(history);
    }
    this.panel.querySelector('[data-train-action="stop"]').disabled = !trainer;
    this.panel.querySelector('[data-train-action="next"]').disabled = !trainer;
    this.panel.querySelector('[data-train-action="start"]').textContent = trainer ? 'Restart' : 'Start';
  }

  #refreshChampion() {
    const el = this.panel.querySelector('[data-champion]');
    const c = this.champion;
    el.textContent = c
      ? `${c.fitness.toFixed(0)} m · generation ${c.generation} · ${c.brain.network.sizes.join('-')} network`
      : 'none yet';
  }
}
