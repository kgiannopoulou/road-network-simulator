import { clearChampion, loadChampion, saveChampion } from '../ai/championStore.js';
import { TRAINER_DEFAULTS } from '../ai/trainer.js';
import { courseInfo, CURRICULUM } from '../training/courses.js';
import { FITNESS_LABELS, FITNESS_WEIGHTS } from '../training/fitness.js';
import { LocalRunner, WorkerRunner, workersAvailable } from '../training/runner.js';
import { SESSION_DEFAULTS } from '../training/session.js';
import { SPEEDS, STEPS_PER_SECOND } from '../training/speed.js';
import { LineChart } from './lineChart.js';
import { drawNetwork } from './networkView.js';

/** Genetic-algorithm settings read from the panel when a run starts. */
const LIVE = ['mutationRate', 'mutationAmount', 'crossoverRate', 'elitism', 'tournamentSize'];

/**
 * Week 19: the training dashboard. Generation, population, best and average
 * fitness, mutation rate, survival, training time and throughput as tiles;
 * fitness and survival plotted over generations with course changes marked;
 * the leader's brain and fitness breakdown; curriculum progress; the
 * champion; and every setting. Week 20 controls (speed, rendering on/off,
 * main thread vs Web Worker) live here too.
 */
export class TrainingDashboard {
  constructor(panel, { getMap, onAutopilot, onRunnerChange } = {}) {
    this.panel = panel;
    this.getMap = getMap;
    this.onAutopilot = onAutopilot;
    this.onRunnerChange = onRunnerChange;
    this.render = true;
    this.speed = 1;
    this.useWorker = workersAvailable();
    this.champion = loadChampion();
    this.message = '';
    this.timer = 0;
    this.drawn = '';
    this.$ = (sel) => panel.querySelector(sel);

    this.fitnessChart = new LineChart(this.$('#fitness-chart'), this.$('#fitness-legend'), {
      series: [
        { key: 'best', label: 'Best', color: '#3987e5' },
        { key: 'average', label: 'Average', color: '#d95926' },
      ],
      empty: 'Fitness appears after the first generation',
    });
    this.survivalChart = new LineChart(this.$('#survival-chart'), this.$('#survival-legend'), {
      series: [
        { key: 'survivalPct', label: 'Survived', color: '#199e70' },
        { key: 'reachedPct', label: 'Reached destination', color: '#c98500' },
      ],
      format: (v) => `${v.toFixed(0)}%`,
      yMax: 100,
      empty: 'Survival appears after the first generation',
    });

    this.runner = this.#createRunner();
    this.#buildControls();
    this.#refreshChampion();
    this.#drawCharts([], []);
  }

  get visible() {
    return !this.panel.hidden;
  }

  show(visible) {
    this.panel.hidden = !visible;
  }

  get running() {
    return this.runner.running;
  }

  get snapshot() {
    return this.runner.snapshot;
  }

  #createRunner() {
    const options = {
      onChampion: (champion) => {
        this.champion = champion;
        saveChampion(champion);
        this.#refreshChampion();
      },
      onError: (message) => (this.message = message),
    };
    return this.useWorker ? new WorkerRunner(options) : new LocalRunner(options);
  }

  // ---- controls -------------------------------------------------------------

  #buildControls() {
    const mode = this.$('[data-train="mode"]');
    mode.innerHTML = [
      '<option value="curriculum">Curriculum (all courses)</option>',
      ...CURRICULUM.map((id) => `<option value="${id}">Course: ${courseInfo(id).name}</option>`),
      '<option value="map">Your map (random route)</option>',
    ].join('');

    const speeds = this.$('[data-speeds]');
    speeds.innerHTML = SPEEDS.map((s) => `<button data-speed="${s}">${s === 'max' ? 'Max' : `${s}×`}</button>`).join('');
    speeds.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-speed]');
      if (btn) this.setSpeed(btn.dataset.speed === 'max' ? 'max' : Number(btn.dataset.speed));
    });

    this.$('#curriculum-steps').innerHTML = CURRICULUM.map((id) => `<li data-course="${id}">${courseInfo(id).name}</li>`).join('');

    const weights = this.$('[data-weights]');
    weights.innerHTML = Object.entries(FITNESS_WEIGHTS)
      .map(
        ([key, value]) =>
          `<label class="cfg"><span>${FITNESS_LABELS[key] ?? key}</span><input type="number" step="0.1" min="0" value="${value}" data-weight="${key}" /></label>`,
      )
      .join('');

    for (const el of this.panel.querySelectorAll('input[type="range"][data-train]')) {
      const out = this.$(`[data-out="train-${el.dataset.train}"]`);
      el.addEventListener('input', () => {
        if (out) out.textContent = el.value;
      });
      if (out) out.textContent = el.value;
    }

    const on = (action, fn) => this.$(`[data-train-action="${action}"]`).addEventListener('click', fn);
    on('start', () => this.start());
    on('stop', () => this.stop());
    on('pause', () => this.setPaused(!this.runner.paused));
    on('next', () => this.runner.next());
    on('skip', () => this.runner.skipCourse());
    on('forget', () => this.forgetChampion());
    on('autopilot', () => this.onAutopilot?.());
    this.$('[data-train="render"]').addEventListener('change', (e) => (this.render = e.target.checked));
    const worker = this.$('[data-train="worker"]');
    worker.checked = this.useWorker;
    worker.disabled = !workersAvailable();
    worker.addEventListener('change', (e) => {
      this.useWorker = e.target.checked;
      this.runner.stop();
      this.runner.dispose?.();
      this.runner = this.#createRunner();
      this.runner.setSpeed(this.speed);
      this.onRunnerChange?.();
    });
    this.setSpeed(1);
  }

  setSpeed(speed) {
    this.speed = speed;
    this.runner.setSpeed(speed);
    for (const b of this.panel.querySelectorAll('[data-speed]')) {
      b.classList.toggle('active', b.dataset.speed === String(speed));
    }
  }

  cycleSpeed(direction = 1) {
    const i = SPEEDS.indexOf(this.speed);
    this.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + direction))]);
  }

  setPaused(paused) {
    this.runner.setPaused(paused);
    this.$('[data-train-action="pause"]').textContent = paused ? 'Resume' : 'Pause';
  }

  toggleRender() {
    this.render = !this.render;
    this.$('[data-train="render"]').checked = this.render;
  }

  #config() {
    const num = (name) => Number(this.$(`[data-train="${name}"]`).value);
    const checked = (name) => this.$(`[data-train="${name}"]`).checked;
    const weights = {};
    for (const el of this.panel.querySelectorAll('[data-weight]')) weights[el.dataset.weight] = Number(el.value);
    const mode = this.$('[data-train="mode"]').value;
    const trainer = {
      ...TRAINER_DEFAULTS,
      populationSize: num('populationSize'),
      hidden: [num('hidden')],
      sensorNoise: checked('sensorNoise'),
      allowReverse: checked('allowReverse'),
      seed: Math.floor(Math.random() * 1e9),
    };
    for (const key of LIVE) trainer[key] = num(key);
    delete trainer.onGenerationEnd;
    return {
      ...SESSION_DEFAULTS,
      mode,
      passShare: num('passShare') / 100,
      weights,
      map: mode === 'map' ? this.getMap() : null,
      mapTraffic: mode === 'map' ? num('mapTraffic') : 0,
      trainer,
      champion: checked('continueChampion') ? this.champion : null,
    };
  }

  start() {
    this.message = '';
    const config = this.#config();
    if (config.mode === 'map' && (!config.map || config.map.segments.length === 0)) {
      this.message = 'Your map has no roads.';
      return;
    }
    try {
      this.runner.start(config);
    } catch (err) {
      this.message = err.message;
    }
    this.setPaused(false);
    this.drawn = '';
  }

  stop() {
    this.runner.stop();
    this.drawn = '';
  }

  forgetChampion() {
    clearChampion();
    this.champion = null;
    this.#refreshChampion();
  }

  // ---- per frame ------------------------------------------------------------

  /** Runs every frame while in Train mode (and keeps a worker's clock going). */
  update(rawDelta) {
    this.runner.tick(rawDelta);
    if (!this.visible) return;
    const snap = this.runner.snapshot;

    if (snap?.leader?.brain) drawNetwork(this.$('#network-view'), toBrainView(snap.leader.brain));
    else drawNetwork(this.$('#network-view'), null);

    this.timer += rawDelta;
    if (this.timer < 0.2) return;
    this.timer = 0;
    this.#updateTiles(snap);
    this.#updateCurriculum(snap);
    this.#updateBreakdown(snap);

    const key = snap ? `${snap.history.length}:${snap.events.length}` : '';
    if (key !== this.drawn) {
      this.drawn = key;
      this.#drawCharts(snap?.history ?? [], snap?.events ?? []);
    }

    const running = this.runner.running;
    for (const action of ['stop', 'pause', 'next']) this.$(`[data-train-action="${action}"]`).disabled = !running;
    this.$('[data-train-action="skip"]').disabled = !running || snap?.mode !== 'curriculum';
    this.$('[data-train-action="start"]').textContent = running ? 'Restart' : 'Start';
  }

  #updateTiles(snap) {
    const set = (name, value, sub = '') => {
      this.$(`[data-tile="${name}"] b`).textContent = value;
      this.$(`[data-tile="${name}"] small`).textContent = sub;
    };
    const last = snap?.history.at(-1);
    const r = this.runner;
    if (!snap) {
      for (const t of ['generation', 'population', 'best', 'average', 'mutation', 'survival', 'time', 'sim', 'speed']) set(t, '–');
      this.$('[data-train-status]').textContent = this.message || 'Not training. Pick a course and press Start.';
      return;
    }
    const s = snap.stats;
    set('generation', String(s.generation), `${s.time.toFixed(0)} / ${s.generationTime} s`);
    set('population', String(s.population), `${s.alive} alive now`);
    set('best', last ? last.best.toFixed(0) : '–', `champion ${snap.champion ? snap.champion.fitness.toFixed(0) : '–'}`);
    set('average', last ? last.average.toFixed(0) : '–', 'last generation');
    set('mutation', `${(s.mutationRate * 100).toFixed(0)}%`, 'per gene');
    set('survival', last ? `${(last.survival * 100).toFixed(0)}%` : '–', last ? `${(last.reached * 100).toFixed(0)}% arrived` : '');
    set('time', formatDuration(r.trainingTime), r.paused ? 'paused' : r.kind);
    set('sim', formatDuration(snap.simTime), `${snap.steps.toLocaleString()} steps`);
    const realtime = r.stepsPerSecond / STEPS_PER_SECOND;
    set('speed', `${realtime.toFixed(realtime < 10 ? 1 : 0)}×`, `${Math.round(r.stepsPerSecond).toLocaleString()} steps/s`);
    const now = `${s.alive}/${s.total} alive · ${s.crashed} crashed · ${s.stalled + s.lost} stalled/lost · ${s.finished} arrived`;
    this.$('[data-train-status]').textContent = this.message || snap.message || now;
  }

  #updateCurriculum(snap) {
    const list = this.$('#curriculum-steps');
    list.classList.toggle('single', snap?.mode !== 'curriculum');
    for (const li of list.children) {
      const i = CURRICULUM.indexOf(li.dataset.course);
      li.className = !snap ? '' : snap.mode === 'curriculum' ? (i < snap.courseIndex ? 'done' : i === snap.courseIndex ? 'current' : '') : snap.course === li.dataset.course ? 'current' : '';
    }
    const info = snap ? courseInfo(snap.course) : null;
    this.$('[data-course-info]').textContent = snap
      ? `${info ? info.description : 'Your own road network along a random route.'}${snap.mode === 'curriculum' ? ` Next course when ${(snap.passShare * 100).toFixed(0)}% arrive 3 generations running (${snap.streak}/3).` : ''}`
      : '';
  }

  #updateBreakdown(snap) {
    const el = this.$('[data-breakdown]');
    const parts = snap?.leader?.parts;
    if (!parts) {
      el.innerHTML = '<p class="hint">The leader\'s score, term by term, appears here.</p>';
      return;
    }
    const entries = Object.entries(parts).filter(([, v]) => Math.abs(v) >= 0.05);
    const max = Math.max(1, ...entries.map(([, v]) => Math.abs(v)));
    el.innerHTML =
      `<div class="total">Leader <b>${snap.leader.fitness.toFixed(1)}</b>${snap.leader.outcome ? ` · ${snap.leader.outcome}` : ''}</div>` +
      entries
        .map(
          ([k, v]) =>
            `<div class="bar"><span>${FITNESS_LABELS[k] ?? k}</span><i class="${v < 0 ? 'neg' : 'pos'}" style="width:${(Math.abs(v) / max) * 100}%"></i><em>${v >= 0 ? '+' : ''}${v.toFixed(1)}</em></div>`,
        )
        .join('');
  }

  #drawCharts(history, events) {
    const markers = events.slice(1).map((e) => ({ generation: e.generation, label: courseInfo(e.course)?.short ?? e.course }));
    this.fitnessChart.draw(history, markers);
    this.survivalChart.draw(
      history.map((h) => ({ ...h, survivalPct: h.survival * 100, reachedPct: h.reached * 100 })),
      markers,
    );
  }

  #refreshChampion() {
    const c = this.champion;
    const course = c?.course ? courseInfo(c.course)?.name ?? c.course : 'your map';
    this.$('[data-champion]').textContent = c
      ? `${c.fitness.toFixed(0)} pts · ${course} · gen ${c.generation} · ${c.brain.network.sizes.join('-')}${c.brain.navigation ? ' · navigates' : ''}`
      : 'none yet';
  }
}

/** Snapshot brain JSON → the shape drawNetwork() expects. */
function toBrainView(json) {
  const sizes = json.network.sizes;
  const layers = json.network.layers.map((l, k) => ({
    inputCount: sizes[k],
    outputCount: sizes[k + 1],
    weights: l.weights,
    biases: l.biases,
    outputs: json.activations?.[k] ?? new Array(sizes[k + 1]).fill(0),
  }));
  const labels = [
    ...Array.from({ length: json.sensor.rayCount }, (_, i) => `ray ${i + 1}`),
    'speed',
    ...(json.navigation ? ['route', 'lane'] : []),
  ];
  return { network: { sizes, layers }, lastInputs: json.lastInputs, inputLabels: labels };
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return h > 0 ? `${h}h ${String(mins).padStart(2, '0')}m` : `${mins}:${String(secs).padStart(2, '0')}`;
}
