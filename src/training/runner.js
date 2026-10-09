import { TrainingSession } from './session.js';
import { MAX_SLICE_MS, StepMeter, stepsDue } from './speed.js';

/**
 * Week 20: two ways to run a training session behind one interface.
 *
 *   LocalRunner   steps the session on the main thread inside the render loop
 *   WorkerRunner  runs it in a Web Worker; the page only receives snapshots
 *
 * Both expose start(config) / stop() / setSpeed() / setPaused() / next() /
 * skipCourse() / tick(rawDelta), the latest `snapshot`, the wall-clock
 * `trainingTime`, `stepsPerSecond`, and call onChampion(champion).
 */
class BaseRunner {
  constructor({ onChampion = () => {}, onError = () => {} } = {}) {
    this.onChampion = onChampion;
    this.onError = onError;
    this.snapshot = null;
    this.config = null;
    this.speed = 1;
    this.paused = false;
    this.running = false;
    this.trainingTime = 0; // wall-clock seconds spent training
    this.meter = new StepMeter();
  }

  get stepsPerSecond() {
    return this.meter.stepsPerSecond;
  }

  tick(rawDelta) {
    if (this.running && !this.paused) this.trainingTime += rawDelta;
  }
}

export class LocalRunner extends BaseRunner {
  constructor(options) {
    super(options);
    this.kind = 'main thread';
    this.session = null;
    this.carry = 0;
    this.snapshotTimer = 0;
  }

  start(config) {
    this.config = config;
    this.session = new TrainingSession(config).start();
    this.running = true;
    this.trainingTime = 0;
    this.carry = 0;
    this.snapshot = this.session.snapshot();
  }

  stop() {
    this.session = null;
    this.running = false;
    this.snapshot = null;
  }

  setSpeed(speed) {
    this.speed = speed;
    this.carry = 0;
  }

  setPaused(paused) {
    this.paused = paused;
  }

  next() {
    this.session?.trainer.nextGeneration();
  }

  skipCourse() {
    this.session?.skipCourse();
  }

  tick(rawDelta) {
    super.tick(rawDelta);
    if (!this.session) return;
    if (!this.paused) {
      const start = performance.now();
      let due;
      ({ due, carry: this.carry } = stepsDue(this.speed, rawDelta, this.carry));
      // Leave the rest of the frame for rendering.
      const budget = this.speed === 'max' ? 24 : MAX_SLICE_MS;
      let done = 0;
      while (due > 0 && performance.now() - start < budget) {
        const n = Math.min(due, 10);
        this.session.run(n);
        due -= n;
        done += n;
      }
      this.meter.add(done, rawDelta);
    }
    const champion = this.session.takeChampion();
    if (champion) this.onChampion(champion);
    this.snapshotTimer += rawDelta;
    if (this.snapshotTimer >= 1 / 30) {
      this.snapshotTimer = 0;
      this.snapshot = this.session.snapshot();
    }
  }
}

export class WorkerRunner extends BaseRunner {
  constructor(options) {
    super(options);
    this.kind = 'Web Worker';
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.lastSteps = 0;
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'snapshot') {
        if (!this.running) return;
        const steps = data.snapshot.steps;
        const now = performance.now();
        if (this.lastSnapshotAt) {
          const advance = steps >= this.lastSteps ? steps - this.lastSteps : steps;
          this.meter.add(advance, (now - this.lastSnapshotAt) / 1000);
        }
        this.lastSteps = steps;
        this.lastSnapshotAt = now;
        this.snapshot = data.snapshot;
      } else if (data.type === 'champion') {
        this.onChampion(data.champion);
      } else if (data.type === 'error') {
        this.running = false;
        this.onError(data.message);
      }
    };
    this.worker.onerror = (e) => this.onError(e.message || 'Training worker failed');
  }

  start(config) {
    this.config = config;
    this.running = true;
    this.trainingTime = 0;
    this.snapshot = null;
    this.lastSnapshotAt = 0;
    this.lastSteps = 0;
    this.worker.postMessage({ type: 'speed', speed: this.speed });
    this.worker.postMessage({ type: 'pause', paused: this.paused });
    this.worker.postMessage({ type: 'start', config });
  }

  stop() {
    this.running = false;
    this.snapshot = null;
    this.worker.postMessage({ type: 'stop' });
  }

  setSpeed(speed) {
    this.speed = speed;
    this.worker.postMessage({ type: 'speed', speed });
  }

  setPaused(paused) {
    this.paused = paused;
    this.worker.postMessage({ type: 'pause', paused });
  }

  next() {
    this.worker.postMessage({ type: 'next' });
  }

  skipCourse() {
    this.worker.postMessage({ type: 'skip' });
  }

  dispose() {
    this.worker.terminate();
  }
}

export function workersAvailable() {
  return typeof Worker !== 'undefined';
}
