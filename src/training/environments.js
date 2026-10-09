import { FitnessEvaluator } from './fitness.js';

/**
 * Environments plug into the Trainer. Each one provides:
 *
 *   spawn, world, roads      where cars start, collision geometry, roads
 *   navigation               whether brains get route inputs
 *   rank                     curriculum position (a champion from a harder
 *                            course beats one from an easier course)
 *   timeLimit                seconds per generation (or null = trainer's)
 *   beginGeneration()        reset traffic etc.
 *   step(dt)                 advance anything that moves on its own
 *   obstacles()              cars agents can crash into
 *   evaluator()              per-car scorer: update(car, dt, reading) →
 *                            outcome | null, crash(), fitness, parts
 *   navigationInputs(eval)   route inputs for the brain (or null)
 */

/** Phase 5: a course (or your map) with a route and the Week 17 fitness. */
export class CourseEnvironment {
  constructor(trainingWorld, { weights, rank = 0 } = {}) {
    this.tw = trainingWorld;
    this.weights = weights;
    this.rank = rank;
    this.navigation = true;
    this.spawn = trainingWorld.spawn;
    this.world = trainingWorld.world;
    this.roads = trainingWorld.roads;
    this.timeLimit = trainingWorld.timeLimit;
    this.course = trainingWorld.course;
  }

  beginGeneration() {
    this.tw.resetTraffic();
  }

  step(dt) {
    this.tw.step(dt);
  }

  obstacles() {
    return this.tw.obstacles();
  }

  evaluator() {
    return new FitnessEvaluator(this.tw.createNavigator(), {
      weights: this.weights,
      speedLimit: this.tw.speedLimit,
      timeLimit: this.tw.timeLimit,
    });
  }

  navigationInputs(evaluator) {
    return evaluator.nav.inputs();
  }
}
