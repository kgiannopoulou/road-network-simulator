import { Car } from '../car/car.js';
import { PhysicsModel, SURFACES } from '../car/physics.js';
import { m } from '../car/units.js';
import { satCollision } from '../collision/sat.js';
import { createRng } from '../math/random.js';
import { Point } from '../primitives/point.js';
import { imperfectionsFor, PRESETS } from '../sensors/imperfections.js';
import { RayCaster } from '../sensors/raycast.js';
import { RaySensor } from '../sensors/raySensor.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { Brain, DEFAULT_BRAIN_SENSOR } from './brain.js';
import { RoadCoverage } from './coverage.js';
import { GA_DEFAULTS, mutate, nextGeneration } from './genetics.js';
import { NeuralNetwork } from './network.js';

export const TRAINER_DEFAULTS = {
  populationSize: 150,
  hidden: [8],
  sensor: DEFAULT_BRAIN_SENSOR,
  generationTime: 40, // s of simulated time per generation (unless the environment sets one)
  stallTime: 4, // s without reaching new road before a car is removed (coverage environment)
  sensorNoise: false, // train with the 'realistic' sensor preset
  allowReverse: false,
  seed: 1,
  ...GA_DEFAULTS,
};

/**
 * Phase 4 environment: drive anywhere, fitness = metres of distinct road.
 * See src/training/environments.js for the interface.
 */
export class CoverageEnvironment {
  constructor(roads, world, { spawn = null, stallTime = 4 } = {}) {
    this.roads = roads;
    this.world = world;
    this.spawn = spawn ?? Trainer.chooseSpawn(roads);
    this.coverage = new RoadCoverage(roads);
    this.stallTime = stallTime;
    this.navigation = false;
    this.rank = 0;
    this.timeLimit = null;
    this.extraObstacles = [];
  }

  beginGeneration() {}

  step() {}

  obstacles() {
    return this.extraObstacles;
  }

  evaluator() {
    const tracker = this.coverage.tracker();
    const stallTime = this.stallTime;
    let time = 0;
    let lastProgress = 0;
    return {
      fitness: 0,
      parts: null,
      reached: false,
      update(car, dt) {
        time += dt;
        if (tracker.visit(car.position)) {
          lastProgress = time;
          this.fitness = tracker.metres;
        }
        return time - lastProgress > stallTime ? 'stalled' : null;
      },
      crash() {},
    };
  }

  navigationInputs() {
    return null;
  }
}

/**
 * Weeks 15–16 (and 18): population training.
 *
 * Every generation spawns `populationSize` cars at the environment's start,
 * each with its own brain and ray sensor. The cars are ghosts to each other
 * but crash into road borders and the environment's obstacles (parked cars,
 * traffic). A car is removed when it crashes or its evaluator ends the run
 * (stalled, lost, finished); the generation ends when every car is out or
 * time runs out. The next generation comes from the genetic algorithm, and
 * the best brain ever seen is kept as the champion.
 *
 * The simulation is stepped with a fixed dt by the caller, so a brain scores
 * exactly the same every time it drives: elites replay their score.
 */
export class Trainer {
  constructor(roads, world, options = {}) {
    this.options = { ...TRAINER_DEFAULTS, ...options };
    this.rng = createRng(this.options.seed);
    this.environment =
      options.environment ?? new CoverageEnvironment(roads, world, { spawn: options.spawn, stallTime: this.options.stallTime });
    this.caster = new RayCaster(this.environment.world);

    this.generation = 0;
    this.time = 0;
    this.steps = 0; // simulation steps taken, for steps/s
    this.agents = [];
    this.history = []; // [{ generation, best, average, survival, reached, champion, course, mutationRate }]
    this.champion = options.champion ?? null; // { brain (JSON), fitness, generation, rank, course }
    this.championChanged = false;
  }

  get spawn() {
    return this.environment.spawn;
  }

  get world() {
    return this.environment.world;
  }

  get generationTime() {
    return this.environment.timeLimit ?? this.options.generationTime;
  }

  /** Swap the environment (curriculum); the next generation spawns there. */
  setEnvironment(environment) {
    this.environment = environment;
    this.caster = new RayCaster(environment.world);
  }

  /**
   * Default start: the right-hand lane at the beginning of the longest run of
   * road without sharp turns, so the first lesson is plain road following.
   * Ties go to the start with the most road reachable beyond it.
   */
  static chooseSpawn(roads, { fraction = null } = {}) {
    if (roads.length === 0) return null;
    const planner = new RoutePlanner(roads);
    const heading = (step) => {
      const { a, b } = RoutePlanner.laneLine(step, 0);
      return b.subtract(a).angle();
    };
    const straightRun = (start) => {
      const seen = new Set([start.road]);
      let step = start;
      let total = start.road.segment.length();
      for (;;) {
        let next = null;
        let bestTurn = Math.PI / 5; // 36°: anything sharper ends the run
        for (const option of planner.nextOptions(step)) {
          const turn = Math.abs(Math.atan2(Math.sin(heading(option) - heading(step)), Math.cos(heading(option) - heading(step))));
          if (turn < bestTurn && !seen.has(option.road)) {
            bestTurn = turn;
            next = option;
          }
        }
        if (!next) return total;
        seen.add(next.road);
        total += next.road.segment.length();
        step = next;
      }
    };
    const reach = (start) => {
      const seen = new Set([start.road]);
      const queue = [start];
      let total = 0;
      while (queue.length) {
        const step = queue.shift();
        total += step.road.segment.length();
        for (const next of planner.nextOptions(step)) {
          if (!seen.has(next.road)) {
            seen.add(next.road);
            queue.push(next);
          }
        }
      }
      return total;
    };
    let best = null;
    for (const step of planner.allSteps()) {
      const score = straightRun(step) + reach(step) * 0.1;
      if (!best || score > best.score) best = { step, score };
    }
    const { a, b } = RoutePlanner.laneLine(best.step, 0);
    const p = Point.lerp(a, b, fraction ?? Math.min(0.15, m(6) / a.distanceTo(b)));
    return { x: p.x, y: p.y, angle: b.subtract(a).angle() };
  }

  get alive() {
    return this.agents.filter((a) => a.alive);
  }

  /** The car to watch: best alive driver, or the best of the generation. */
  get leader() {
    let best = null;
    for (const a of this.agents) {
      if (!best || (a.alive && !best.alive) || (a.alive === best.alive && a.fitness > best.fitness)) best = a;
    }
    return best;
  }

  /** Start generation 0: fresh random brains, or the champion and its mutants. */
  start() {
    const { populationSize } = this.options;
    const genomes = [];
    if (this.champion) {
      const base = this.#networkFrom(this.champion.brain).toGenome();
      genomes.push(base);
      while (genomes.length < populationSize) {
        genomes.push(mutate(base, { rate: this.options.mutationRate * 2, amount: this.options.mutationAmount }, this.rng));
      }
    } else {
      const template = this.#newNetwork();
      for (let i = 0; i < populationSize; i++) genomes.push(template.randomize(this.rng).toGenome());
    }
    this.generation = 0;
    this.history = [];
    this.#spawnGeneration(genomes);
  }

  get inputCount() {
    return Brain.inputCount(this.options.sensor, this.environment.navigation);
  }

  #newNetwork() {
    return new NeuralNetwork([this.inputCount, ...this.options.hidden, 3]);
  }

  /** A champion trained with a different layout can't seed this run. */
  #networkFrom(brainJson) {
    const network = NeuralNetwork.fromJSON(brainJson.network);
    const expected = this.#newNetwork();
    if (network.sizes.join() !== expected.sizes.join()) {
      throw new Error(`Champion network ${network.sizes.join('-')} doesn't match ${expected.sizes.join('-')}`);
    }
    return network;
  }

  #spawnGeneration(genomes) {
    const { sensor, sensorNoise, allowReverse } = this.options;
    const env = this.environment;
    const template = this.#newNetwork();
    env.beginGeneration();
    this.time = 0;
    this.agents = genomes.map((genome, i) => {
      const car = new Car({ x: env.spawn.x, y: env.spawn.y, angle: env.spawn.angle, color: '#4aa3ff', kind: 'agent' });
      const brain = new Brain({ sensor, navigation: env.navigation, allowReverse, network: template.clone().setGenome(genome) });
      const raySensor = new RaySensor({ name: 'rays', ...sensor, seed: this.generation * 1000 + i + 1 });
      if (sensorNoise) raySensor.configure(imperfectionsFor(raySensor.spec, PRESETS.realistic));
      return {
        car,
        brain,
        genome,
        sensor: raySensor,
        evaluator: env.evaluator(),
        alive: true,
        fitness: 0,
        outcome: null, // 'crashed' | 'stalled' | 'lost' | 'finished' | 'timeout'
        elite: i < Math.min(this.options.elitism, genomes.length) && this.generation > 0,
      };
    });
  }

  /**
   * Advance every live car by dt. `obstacles` adds cars to hit on top of the
   * environment's own; `surface` and `model` match the main simulation.
   */
  update(dt, { obstacles = [], surface = SURFACES.dry, model = PhysicsModel.REALISTIC } = {}) {
    if (this.agents.length === 0) return;
    const env = this.environment;
    this.time += dt;
    this.steps++;
    env.step(dt);
    const hazards = obstacles.length ? [...env.obstacles(), ...obstacles] : env.obstacles();
    const sense = { time: this.time, dt, cars: hazards, caster: this.caster };

    for (const agent of this.agents) {
      if (!agent.alive) continue;
      const { car, evaluator } = agent;
      agent.sensor.update({ ...sense, car });
      const reading = agent.sensor.read(this.time);
      car.input = agent.brain.drive(reading, car, env.navigationInputs(evaluator));
      car.surface = surface;
      car.step(dt, model);

      if (this.#crashed(car, hazards)) {
        evaluator.crash();
        agent.fitness = evaluator.fitness;
        this.#retire(agent, 'crashed');
        continue;
      }
      const outcome = evaluator.update(car, dt, reading);
      agent.fitness = evaluator.fitness;
      if (outcome) this.#retire(agent, outcome);
    }

    if (this.time >= this.generationTime) {
      for (const agent of this.agents) if (agent.alive) this.#retire(agent, 'timeout');
    }
    if (this.agents.every((a) => !a.alive)) this.nextGeneration();
  }

  #crashed(car, obstacles) {
    if (this.world.touchesRoadEdge(car)) return true;
    const poly = car.polygon();
    for (const other of obstacles) {
      const reach = car.radius + other.radius;
      if (Math.abs(other.state.x - car.state.x) > reach || Math.abs(other.state.y - car.state.y) > reach) continue;
      if (satCollision(poly.points, other.polygon().points)) return true;
    }
    return false;
  }

  #retire(agent, outcome) {
    agent.alive = false;
    agent.outcome = outcome;
    agent.car.input = { forward: 0, back: 0, steer: 0 };
  }

  /** Score the generation, update the champion and breed the next one. */
  nextGeneration() {
    if (this.agents.length === 0) return;
    const env = this.environment;
    const scored = this.agents.map((a) => ({ genome: a.genome, fitness: a.fitness, agent: a }));
    const best = scored.reduce((x, y) => (y.fitness > x.fitness ? y : x));
    const average = scored.reduce((sum, s) => sum + s.fitness, 0) / scored.length;
    const n = this.agents.length;
    const rank = env.rank ?? 0;

    const better =
      !this.champion ||
      rank > (this.champion.rank ?? 0) ||
      (rank === (this.champion.rank ?? 0) && best.fitness > this.champion.fitness);
    if (better) {
      this.champion = {
        brain: best.agent.brain.toJSON(),
        fitness: best.fitness,
        generation: this.generation,
        rank,
        course: env.course?.id ?? null,
      };
      this.championChanged = true;
    }

    const entry = {
      generation: this.generation,
      best: best.fitness,
      average,
      survival: this.agents.filter((a) => a.outcome !== 'crashed').length / n,
      reached: this.agents.filter((a) => a.outcome === 'finished').length / n,
      champion: this.champion.fitness,
      course: env.course?.id ?? null,
      mutationRate: this.options.mutationRate,
      population: n,
    };
    this.history.push(entry);

    const genomes = nextGeneration(scored, this.options.populationSize, this.options, this.rng);
    this.generation++;
    // Hook for the curriculum: it may switch the environment before the next spawn.
    this.options.onGenerationEnd?.(entry, this);
    this.#spawnGeneration(genomes);
  }

  stats() {
    const leader = this.leader;
    const count = (outcome) => this.agents.filter((a) => a.outcome === outcome).length;
    return {
      generation: this.generation,
      time: this.time,
      alive: this.alive.length,
      total: this.agents.length,
      leaderFitness: leader?.fitness ?? 0,
      champion: this.champion?.fitness ?? 0,
      crashed: count('crashed'),
      stalled: count('stalled'),
      lost: count('lost'),
      finished: count('finished'),
    };
  }

  // ---- drawing (in-thread Phase 4 view) ------------------------------------

  draw(ctx, px) {
    const leader = this.leader;
    for (const agent of this.agents) {
      if (!agent.alive || agent === leader) continue;
      agent.car.alpha = 0.3;
      agent.car.draw(ctx);
    }
    if (!leader) return;
    const reading = leader.sensor.read(this.time);
    if (reading) leader.sensor.draw(ctx, reading, px);
    leader.car.alpha = 1;
    leader.car.color = '#30d158';
    leader.car.draw(ctx, { highlight: leader.alive ? null : '#ff3b30' });
    leader.car.color = '#4aa3ff';
  }

  /** Spawn marker so it's clear where every generation starts. */
  drawSpawn(ctx, px) {
    if (!this.spawn) return;
    const p = new Point(this.spawn.x, this.spawn.y);
    const f = Point.fromAngle(this.spawn.angle).scale(m(3));
    ctx.beginPath();
    ctx.arc(p.x, p.y, m(1.2), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(48, 209, 88, 0.8)';
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + f.x, p.y + f.y);
    ctx.stroke();
  }
}
