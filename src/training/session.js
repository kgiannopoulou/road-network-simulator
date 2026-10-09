import { Trainer, TRAINER_DEFAULTS } from '../ai/trainer.js';
import { CURRICULUM } from './courses.js';
import { CourseEnvironment } from './environments.js';
import { FITNESS_WEIGHTS } from './fitness.js';
import { TrainingWorld } from './trainingWorld.js';

export const SESSION_DEFAULTS = {
  mode: 'curriculum', // 'curriculum' | a course id | 'map'
  passShare: 0.05, // share of the population that must reach the destination…
  passStreak: 3, // …this many generations in a row to move on
  weights: FITNESS_WEIGHTS,
  map: null, // graph JSON for mode 'map'
  mapTraffic: 0,
  trainer: {},
  champion: null,
};

export const FIXED_DT = 1 / 60; // every training step, whatever the frame rate

/**
 * Week 18: a training run through the curriculum (or on one course, or on
 * the user's map). Owns the TrainingWorld and the Trainer, moves to the next
 * course when enough cars reach the destination, and produces plain-data
 * snapshots for the dashboard and renderer, which works the same whether the
 * session runs on the main thread or in a Web Worker.
 */
export class TrainingSession {
  constructor(config = {}) {
    this.config = { ...SESSION_DEFAULTS, ...config, trainer: { ...TRAINER_DEFAULTS, ...config.trainer } };
    const mode = this.config.mode;
    this.curriculum = mode === 'curriculum';
    this.courseIndex = this.curriculum ? 0 : Math.max(0, CURRICULUM.indexOf(mode));
    this.streak = 0;
    this.events = []; // [{ generation, course }]: course changes, for the chart
    this.simTime = 0;
    this.message = '';

    const env = this.#environment();
    this.trainer = new Trainer(null, null, {
      ...this.config.trainer,
      environment: env,
      champion: this.config.champion,
      onGenerationEnd: (entry) => this.#onGenerationEnd(entry),
    });
    this.events.push({ generation: 0, course: env.course.id });
  }

  get courseId() {
    return this.trainer.environment.course.id;
  }

  #environment() {
    const mode = this.config.mode;
    const source = mode === 'map' ? { map: this.config.map, traffic: this.config.mapTraffic } : { course: this.curriculum ? CURRICULUM[this.courseIndex] : mode };
    this.world = new TrainingWorld(source, { seed: this.config.trainer.seed });
    return new CourseEnvironment(this.world, { weights: this.config.weights, rank: mode === 'map' ? 0 : this.courseIndex });
  }

  /** Start generation 0, continuing from the champion when its network fits. */
  start() {
    try {
      this.trainer.start();
    } catch (err) {
      this.message = `${err.message}: started from scratch.`;
      this.trainer.champion = null;
      this.trainer.start();
    }
    return this;
  }

  step(dt = FIXED_DT) {
    this.trainer.update(dt);
    this.simTime += dt;
  }

  /** Run `count` fixed steps. */
  run(count) {
    for (let i = 0; i < count; i++) this.step();
  }

  skipCourse() {
    if (!this.curriculum || this.courseIndex >= CURRICULUM.length - 1) return false;
    this.#advance();
    // End the current generation without letting the pass check advance again.
    this.skipping = true;
    this.trainer.nextGeneration();
    this.skipping = false;
    return true;
  }

  #onGenerationEnd(entry) {
    if (!this.curriculum || this.skipping) return;
    this.streak = entry.reached >= this.config.passShare ? this.streak + 1 : 0;
    if (this.streak >= this.config.passStreak && this.courseIndex < CURRICULUM.length - 1) this.#advance();
  }

  #advance() {
    this.courseIndex++;
    this.streak = 0;
    this.trainer.setEnvironment(this.#environment());
    this.events.push({ generation: this.trainer.generation, course: this.courseId });
  }

  // ---- snapshots --------------------------------------------------------------

  /** Everything the dashboard and renderer need, as plain (transferable) data. */
  snapshot() {
    const t = this.trainer;
    const agents = new Float32Array(t.agents.length * 4);
    const leader = t.leader;
    t.agents.forEach((a, i) => {
      agents[i * 4] = a.car.state.x;
      agents[i * 4 + 1] = a.car.state.y;
      agents[i * 4 + 2] = a.car.state.angle;
      agents[i * 4 + 3] = (a.alive ? 1 : 0) | (a.outcome === 'finished' ? 2 : 0);
    });
    const pose = (c) => [c.state.x, c.state.y, c.state.angle, c.length, c.width];
    const reading = leader?.sensor.read(t.time);
    return {
      mode: this.config.mode,
      course: this.courseId,
      courseIndex: this.courseIndex,
      courseCount: CURRICULUM.length,
      streak: this.streak,
      passShare: this.config.passShare,
      message: this.message,
      stats: { ...t.stats(), generationTime: t.generationTime, population: t.options.populationSize, mutationRate: t.options.mutationRate },
      simTime: this.simTime,
      steps: t.steps,
      history: t.history,
      events: this.events,
      agents,
      leader: leader
        ? {
            index: t.agents.indexOf(leader),
            fitness: leader.fitness,
            outcome: leader.outcome,
            parts: leader.evaluator.parts ? { ...leader.evaluator.parts } : null,
            brain: {
              ...leader.brain.toJSON(),
              lastInputs: leader.brain.lastInputs,
              lastOutputs: leader.brain.lastOutputs,
              activations: leader.brain.network.layers.map((l) => l.outputs.slice()),
            },
            rays: reading ? reading.data : null,
          }
        : null,
      traffic: (this.world.traffic?.cars ?? []).map((c) => [...pose(c), c.alpha]),
      parked: this.world.parked.map(pose),
      champion: t.champion ? { fitness: t.champion.fitness, generation: t.champion.generation, course: t.champion.course, rank: t.champion.rank } : null,
    };
  }

  /** The champion to save, once per change. */
  takeChampion() {
    if (!this.trainer.championChanged) return null;
    this.trainer.championChanged = false;
    return this.trainer.champion;
  }
}
