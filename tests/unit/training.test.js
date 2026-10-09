import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Car } from '../../src/car/car.js';
import { maxSteerAt } from '../../src/car/physics.js';
import { fromKmh, m } from '../../src/car/units.js';
import { Graph } from '../../src/graph/graph.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { CURRICULUM } from '../../src/training/courses.js';
import { FitnessEvaluator, FITNESS_WEIGHTS } from '../../src/training/fitness.js';
import { LocalRunner } from '../../src/training/runner.js';
import { TrainingSession } from '../../src/training/session.js';
import { stepsDue } from '../../src/training/speed.js';
import { TrainingWorld } from '../../src/training/trainingWorld.js';

/** Ideal driver for feasibility checks: Stanley steering along the route at walking pace. */
function driveCourse(world) {
  const car = new Car({ x: world.spawn.x, y: world.spawn.y, angle: world.spawn.angle });
  let s = 0;
  for (let i = 0; i < 60 * 300 && s < world.path.length - m(6); i++) {
    const p = car.params;
    const front = car.position.add(car.forward.scale(p.wheelbase / 2));
    const proj = world.path.project(front, s - m(2), s + m(10));
    s = proj.s;
    const target = world.path.tangentAt(s + 2).angle();
    const heading = Math.atan2(Math.sin(target - car.state.angle), Math.cos(target - car.state.angle));
    const steer = heading + Math.atan2(-2.5 * proj.lateral, Math.abs(car.speed) + m(1)) + Math.atan(p.wheelbase * world.path.curvatureAt(s));
    car.input = {
      forward: car.speed < m(3) ? 0.4 : 0,
      back: car.speed > m(3.5) ? 0.3 : 0,
      steer: Math.max(-1, Math.min(1, steer / maxSteerAt(p, car.speed))),
      allowReverse: false,
    };
    car.step(1 / 60, 'realistic');
    if (world.world.touchesRoadEdge(car)) return { crashedAt: s };
  }
  return { finished: s >= world.path.length - m(6) };
}

/** A fake navigator for driving the evaluator directly. */
function fakeNav(overrides = {}) {
  return {
    s: 0,
    laneError: 0,
    outside: false,
    distance: 0,
    remaining: m(500),
    laneWidth: 22,
    lanesAt: () => 1,
    update() {},
    ...overrides,
  };
}

describe('Kerb fillets', () => {
  it('round the inside corner of a junction so it is part of the road', () => {
    const graph = new Graph();
    const a = graph.addPoint(new Point(-300, 0));
    const b = graph.addPoint(new Point(0, 0));
    const c = graph.addPoint(new Point(0, 300));
    graph.addSegment(new Segment(a, b));
    graph.addSegment(new Segment(b, c));
    const sharp = new RoadNetwork(graph, { kerbRadius: 0 });
    sharp.update();
    const rounded = new RoadNetwork(graph);
    rounded.update();
    assert.equal(sharp.fillets.length, 0);
    assert.equal(rounded.fillets.length, 1);
    // Just outside the sharp inner corner (−22, 22) is now road.
    const near = new Point(-26, 26);
    assert.ok(!sharp.surfaces().some((p) => p.containsPoint(near)));
    assert.ok(rounded.surfaces().some((p) => p.containsPoint(near)));
  });
});

describe('Week 18: curriculum courses', () => {
  it('has six courses from straight to intersections, each with a valid route', () => {
    assert.deepEqual(CURRICULUM, ['straight', 'curves', 'sharp', 'obstacles', 'traffic', 'intersections']);
    for (const id of CURRICULUM) {
      const world = new TrainingWorld({ course: id });
      assert.ok(world.path.length > m(200), id);
      assert.ok(world.timeLimit > 0 && world.speedLimit > 0);
    }
    assert.equal(new TrainingWorld({ course: 'obstacles' }).parked.length, 5);
    assert.equal(new TrainingWorld({ course: 'traffic' }).traffic.cars.length, 10);
  });

  it('every course can be driven without touching a kerb (by an ideal driver)', () => {
    for (const id of ['straight', 'curves', 'sharp', 'obstacles', 'intersections']) {
      const result = driveCourse(new TrainingWorld({ course: id }));
      assert.ok(result.finished, `${id}: touched the border at ${result.crashedAt}`);
    }
  });

  it('can train on your own map along a seeded random route', () => {
    const graph = new Graph();
    const p = [new Point(0, 0), new Point(800, 0), new Point(800, 600), new Point(1600, 600)].map((x) => graph.addPoint(x));
    for (let i = 0; i < 3; i++) graph.addSegment(new Segment(p[i], p[i + 1]));
    const a = new TrainingWorld({ map: graph.toJSON() }, { seed: 4 });
    const b = new TrainingWorld({ map: graph.toJSON() }, { seed: 4 });
    assert.equal(a.course.id, 'map');
    assert.equal(a.path.length, b.path.length);
  });
});

describe('Navigator', () => {
  it('knows progress, lane offset, leaving the lanes and the bearing to the route', () => {
    const world = new TrainingWorld({ course: 'straight' });
    const nav = world.createNavigator();
    const y = world.spawn.y; // right-hand lane centre
    nav.update(new Point(world.spawn.x + m(20), y), 0);
    assert.ok(Math.abs(nav.laneError) < 1e-6 && !nav.outside);
    assert.ok(Math.abs(nav.bearing) < 1e-6);
    nav.update(new Point(world.spawn.x + m(20), y + m(1)), 0);
    assert.ok(Math.abs(nav.laneError - m(1)) < 1e-6);
    assert.ok(nav.inputs()[1] > 0); // right of the lane centre is positive, like `lateral`
    nav.update(new Point(world.spawn.x + m(20), y - m(3.3)), 0);
    assert.ok(nav.outside); // in the oncoming lane
    nav.update(new Point(world.spawn.x + m(20), y), -Math.PI / 4);
    assert.ok(nav.inputs()[0] > 0.5); // facing left of the route → turn right
  });
});

describe('Week 17: fitness', () => {
  const car = () => {
    const c = new Car();
    c.input = { steer: 0 };
    return c;
  };
  const evaluator = (nav, weights) => new FitnessEvaluator(nav, { weights, speedLimit: fromKmh(50), timeLimit: 30 });

  it('rewards progress and arriving early', () => {
    const nav = fakeNav();
    const e = evaluator(nav);
    nav.s = m(100);
    e.update(car(), 1 / 60, null);
    assert.ok(Math.abs(e.parts.progress - 100) < 1e-6);
    nav.remaining = m(3);
    assert.equal(e.update(car(), 1 / 60, null), 'finished');
    assert.ok(e.reached);
    assert.ok(e.parts.destination > FITNESS_WEIGHTS.destination); // + time bonus
  });

  it('penalises lane errors, leaving the lanes, jerky steering and speeding', () => {
    const nav = fakeNav({ s: m(10), laneError: m(1.3), outside: true });
    const e = evaluator(nav);
    const c = car();
    c.state.speed = fromKmh(80);
    for (let i = 0; i < 60; i++) {
      c.input.steer = i % 2 ? 1 : -1;
      nav.s += 1;
      e.update(c, 1 / 60, null);
    }
    assert.ok(Math.abs(e.parts.lane + FITNESS_WEIGHTS.lane * 1) < 0.05); // (1.3 − 0.3) m for 1 s
    assert.ok(Math.abs(e.parts.leaveLane + FITNESS_WEIGHTS.leaveLane) < 0.05);
    assert.ok(e.parts.steering < -10);
    assert.ok(e.parts.speed < -10);
  });

  it('penalises needless reversing and getting dangerously close', () => {
    const nav = fakeNav({ s: m(5) });
    const e = evaluator(nav);
    const c = car();
    c.state.speed = -m(2);
    const clear = { data: { rays: [{ angle: 0, distance: null }] } };
    e.update(c, 1, clear);
    assert.ok(e.parts.reverse < 0);
    const close = { data: { rays: [{ angle: 0.2, distance: 1 }] } };
    c.state.speed = m(5);
    e.update(c, 1, close);
    assert.ok(e.parts.danger < 0);
  });

  it('crashing, stalling and getting lost cost points', () => {
    const e = evaluator(fakeNav());
    e.crash();
    assert.equal(e.parts.crash, -FITNESS_WEIGHTS.crash);
    const stalled = evaluator(fakeNav());
    let outcome = null;
    for (let i = 0; i < 6 * 60 && !outcome; i++) outcome = stalled.update(car(), 1 / 60, null);
    assert.equal(outcome, 'stalled');
    assert.equal(stalled.parts.stall, -FITNESS_WEIGHTS.stall);
    const lost = evaluator(fakeNav({ distance: m(30) }));
    assert.equal(lost.update(car(), 1 / 60, null), 'lost');
  });
});

describe('Week 18–20: training session', () => {
  it('moves through the curriculum when enough cars arrive', () => {
    // Pass share 0: every generation "passes", so it advances every passStreak generations.
    const session = new TrainingSession({ passShare: 0, passStreak: 1, trainer: { populationSize: 10, seed: 2 } }).start();
    while (session.trainer.generation < 3) session.step();
    assert.equal(session.courseIndex, 3);
    assert.deepEqual(
      session.events.map((e) => e.course),
      ['straight', 'curves', 'sharp', 'obstacles'],
    );
    assert.ok(session.skipCourse());
    assert.equal(session.courseId, 'traffic');
  });

  it('a champion from a harder course outranks a higher score on an easier one', () => {
    const session = new TrainingSession({ passShare: 0, passStreak: 1, trainer: { populationSize: 10, seed: 2 } }).start();
    while (session.trainer.generation < 3) session.step();
    assert.equal(session.trainer.champion.rank, 2); // best of 'sharp', the last finished generation
  });

  it('produces snapshots that survive structured cloning (for the worker)', () => {
    const session = new TrainingSession({ mode: 'curves', trainer: { populationSize: 12, seed: 1 } }).start();
    session.run(30);
    const snap = structuredClone(session.snapshot());
    assert.equal(snap.course, 'curves');
    assert.equal(snap.agents.length, 12 * 4);
    assert.equal(snap.stats.population, 12);
    assert.ok(snap.leader.brain.network.sizes[0] === 10); // 7 rays + speed + 2 navigation
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const s = new TrainingSession({ mode: 'straight', trainer: { populationSize: 15, seed: 5 } }).start();
      while (s.trainer.generation < 2) s.step();
      return s.trainer.history.map((h) => h.best);
    };
    assert.deepEqual(run(), run());
  });

  it('learns the straight course: some cars reach the destination', () => {
    const session = new TrainingSession({ mode: 'straight', trainer: { populationSize: 60, seed: 3 } }).start();
    while (session.trainer.generation < 12) session.step();
    assert.ok(Math.max(...session.trainer.history.map((h) => h.reached)) > 0.05);
  });
});

describe('Week 20: speed', () => {
  it('runs 60 steps per simulated second, times the speed, and drops backlogs', () => {
    assert.equal(stepsDue(1, 1 / 60).due, 1);
    assert.equal(stepsDue(50, 1 / 60).due, 50);
    const { due, carry } = stepsDue(2, 0.01);
    assert.equal(due, 1);
    assert.ok(carry > 0.19 && carry < 0.21);
    assert.equal(stepsDue(1, 10).due, 15); // a hidden tab doesn't cause a 600-step burst
    assert.equal(stepsDue('max', 0.016).due, Infinity);
  });

  it('the main-thread runner advances training at the chosen speed', () => {
    const runner = new LocalRunner();
    runner.start({ mode: 'straight', trainer: { populationSize: 10, seed: 1 } });
    runner.setSpeed(10);
    for (let i = 0; i < 30; i++) runner.tick(1 / 60);
    assert.equal(runner.session.trainer.steps, 300);
    assert.ok(runner.snapshot.steps > 0);
    assert.ok(runner.trainingTime > 0.49);
  });
});
