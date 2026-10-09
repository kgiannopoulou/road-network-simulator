import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIVATIONS } from '../../src/ai/activations.js';
import { Brain } from '../../src/ai/brain.js';
import { CHAMPION_KEY, clearChampion, loadChampion, saveChampion } from '../../src/ai/championStore.js';
import { RoadCoverage } from '../../src/ai/coverage.js';
import { crossover, mutate, nextGeneration, tournament } from '../../src/ai/genetics.js';
import { Layer, NeuralNetwork } from '../../src/ai/network.js';
import { Trainer } from '../../src/ai/trainer.js';
import { Car } from '../../src/car/car.js';
import { fromKmh, m } from '../../src/car/units.js';
import { createDemoGraph } from '../../src/data/demo.js';
import { Graph } from '../../src/graph/graph.js';
import { createRng } from '../../src/math/random.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { Simulation } from '../../src/sim/simulation.js';

function straightWorld(length = 3000) {
  const graph = new Graph();
  const a = graph.addPoint(new Point(0, 0));
  const b = graph.addPoint(new Point(length, 0));
  graph.addSegment(new Segment(a, b, { lanes: 2 }));
  const network = new RoadNetwork(graph);
  network.update();
  const sim = new Simulation(network, { trafficCount: 0 });
  sim.syncRoads();
  return { network, sim };
}

describe('Week 13: neural network', () => {
  it('has the usual activation functions', () => {
    assert.equal(ACTIVATIONS.sigmoid(0), 0.5);
    assert.equal(ACTIVATIONS.relu(-2), 0);
    assert.equal(ACTIVATIONS.step(0.1), 1);
    assert.ok(Math.abs(ACTIVATIONS.tanh(10) - 1) < 1e-6);
  });

  it('a layer computes activation(Σ inputs·weights + bias) per neuron', () => {
    const layer = new Layer(2, 2, 'linear');
    layer.weights = [
      [1, 2],
      [-1, 0.5],
    ];
    layer.biases = [0.5, -1];
    assert.deepEqual(layer.feedForward([3, 4]), [1 * 3 + 2 * 4 + 0.5, -3 + 2 - 1]);
    assert.deepEqual(layer.neuron(1).weights, [-1, 0.5]);
    assert.throws(() => layer.feedForward([1]));
  });

  it('feeds forward through hidden layers to bounded outputs', () => {
    const net = new NeuralNetwork([8, 6, 3], { rng: createRng(1) });
    assert.equal(net.layers.length, 2);
    assert.equal(net.geneCount, 6 * 9 + 3 * 7);
    const out = net.feedForward([1, 0, 0.5, 0, 0, 0.2, 0, 0.3]);
    assert.equal(out.length, 3);
    assert.ok(out.every((v) => v > -1 && v < 1));
  });

  it('serialises, clones and round-trips its genome without changing behaviour', () => {
    const net = new NeuralNetwork([4, 5, 2], { rng: createRng(2) });
    const inputs = [0.1, -0.4, 0.9, 0];
    const copy = NeuralNetwork.fromJSON(JSON.parse(JSON.stringify(net)));
    assert.deepEqual(copy.feedForward(inputs), net.feedForward(inputs));
    const clone = net.clone();
    clone.layers[0].weights[0][0] += 1;
    assert.notDeepEqual(clone.feedForward(inputs), net.feedForward(inputs));
    const rebuilt = new NeuralNetwork([4, 5, 2]).setGenome(net.toGenome());
    assert.deepEqual(rebuilt.feedForward(inputs), net.feedForward(inputs));
  });
});

describe('Week 14: brain ↔ car', () => {
  const reading = (distances, range = 20) => ({
    data: { range, rays: distances.map((distance) => ({ distance })) },
  });

  it('turns ray distances into inputs: nothing seen = 0, touching = 1', () => {
    const brain = new Brain({ rng: createRng(3) });
    const car = new Car();
    car.state.speed = fromKmh(30);
    const inputs = brain.encode(reading([null, 20, 10, 0, null, 5, 15]), car);
    assert.deepEqual(inputs.slice(0, 7), [0, 0, 0.5, 1, 0, 0.75, 0.25]);
    assert.ok(Math.abs(inputs[7] - 0.5) < 1e-9); // 30 of 60 km/h
    assert.deepEqual(brain.encode(null, new Car()), new Array(8).fill(0)); // blind
  });

  it('turns outputs into throttle, brake and steering (no reverse)', () => {
    const brain = new Brain();
    assert.deepEqual(brain.decode([0.8, -0.3, -0.5]), {
      forward: 0.8,
      back: 0,
      steer: -0.5,
      handbrake: false,
      allowReverse: false,
    });
  });

  it('a brain can drive the car by itself (here: a hand-wired one that just accelerates)', () => {
    const { sim } = straightWorld();
    const brain = new Brain();
    for (const layer of brain.network.layers) {
      for (const row of layer.weights) row.fill(0);
      layer.biases.fill(0);
    }
    brain.network.layers[0].biases.fill(1); // hidden neurons on
    brain.network.layers[1].weights[0].fill(1); // → throttle
    sim.enableAutopilot(brain);
    const x0 = sim.player.state.x;
    for (let i = 0; i < 120; i++) sim.update(1 / 60, sim.autopilotInput());
    assert.ok(sim.player.state.x - x0 > m(3));
    assert.equal(sim.sensors.get('rays').rayCount, brain.sensor.rayCount);
  });

  it('survives a JSON round trip with its sensor layout', () => {
    const brain = new Brain({ rng: createRng(4) });
    const copy = Brain.fromJSON(JSON.parse(JSON.stringify(brain)));
    assert.deepEqual(copy.sensor, brain.sensor);
    const r = reading([1, 2, 3, null, 4, 5, 6]);
    assert.deepEqual(copy.drive(r, new Car()), brain.drive(r, new Car()));
  });
});

describe('Week 16: genetic operators', () => {
  const rng = createRng(5);

  it('mutation changes the expected share of genes', () => {
    const genome = new Array(1000).fill(0);
    assert.deepEqual(mutate(genome, { rate: 0, amount: 1 }, rng), genome);
    const changed = mutate(genome, { rate: 0.2, amount: 1 }, rng).filter((g) => g !== 0).length;
    assert.ok(changed > 150 && changed < 250);
  });

  it('crossover takes every gene from one of the parents', () => {
    const a = new Array(200).fill(1);
    const b = new Array(200).fill(2);
    const child = crossover(a, b, rng);
    assert.ok(child.every((g) => g === 1 || g === 2));
    assert.ok(child.includes(1) && child.includes(2));
  });

  it('tournament selection prefers fitter drivers', () => {
    const pop = Array.from({ length: 50 }, (_, i) => ({ genome: [i], fitness: i }));
    assert.equal(tournament(pop, 200, rng).fitness, 49); // a huge tournament finds the best
    let sum = 0;
    for (let i = 0; i < 500; i++) sum += tournament(pop, 4, rng).fitness;
    assert.ok(sum / 500 > 30); // well above the mean of 24.5
  });

  it('a new generation keeps its size and carries the elites over unchanged', () => {
    const scored = Array.from({ length: 30 }, (_, i) => ({ genome: [i, i, i], fitness: i }));
    const next = nextGeneration(scored, 30, { elitism: 3, mutationRate: 1, mutationAmount: 1 }, rng);
    assert.equal(next.length, 30);
    assert.deepEqual(next.slice(0, 3), [
      [29, 29, 29],
      [28, 28, 28],
      [27, 27, 27],
    ]);
  });
});

describe('Weeks 15–16: population training', () => {
  it('fitness counts distinct road, not distance: circling earns nothing', () => {
    const { network } = straightWorld();
    const coverage = new RoadCoverage(network.roads);
    const tracker = coverage.tracker();
    for (let x = 0; x <= m(20); x += 1) tracker.visit(new Point(x, 10));
    const once = tracker.metres;
    assert.ok(Math.abs(once - 20) <= 2);
    for (let x = Math.floor(m(20)); x >= 0; x -= 1) tracker.visit(new Point(x, -10)); // back down the other side
    assert.equal(tracker.metres, once);
    assert.equal(coverage.locate(new Point(100, 500)), null); // off road
  });

  it('removes crashed and stalled cars and moves on when everyone is out', () => {
    const { network, sim } = straightWorld();
    const trainer = new Trainer(network.roads, sim.world, { populationSize: 30, seed: 3, stallTime: 2 });
    trainer.start();
    assert.equal(trainer.agents.length, 30);
    while (trainer.generation === 0) trainer.update(1 / 30);
    assert.equal(trainer.history.length, 1);
    assert.ok(trainer.history[0].best > 0);
    assert.ok(trainer.champion.fitness === trainer.history[0].best);
    assert.equal(trainer.agents.length, 30);
    assert.ok(trainer.agents.every((a) => a.alive));
  });

  it('elites replay their score exactly, so the best never gets worse', () => {
    const { network, sim } = straightWorld();
    const trainer = new Trainer(network.roads, sim.world, { populationSize: 20, seed: 9, generationTime: 15 });
    trainer.start();
    while (trainer.generation < 5) trainer.update(1 / 30);
    const bests = trainer.history.map((h) => h.best);
    for (let i = 1; i < bests.length; i++) assert.ok(bests[i] >= bests[i - 1] - 1e-9);
  });

  it('Milestone #2: a population learns to follow the road on the demo map', () => {
    const net = new RoadNetwork(createDemoGraph());
    net.update();
    const sim = new Simulation(net, { trafficCount: 0 });
    sim.syncRoads();
    const trainer = new Trainer(net.roads, sim.world, { populationSize: 60, seed: 1 });
    trainer.start();
    while (trainer.generation < 10) trainer.update(1 / 30);
    const first = trainer.history[0];
    const last = trainer.history[trainer.history.length - 1];
    // The avenue + the bend to its far end is ~285 m: the best car drives it all.
    assert.ok(trainer.champion.fitness > 250, `champion ${trainer.champion.fitness}`);
    assert.ok(last.average > first.average * 3, `average ${first.average} → ${last.average}`);
  });

  it('saves and loads the champion through localStorage', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    const champion = { brain: new Brain({ rng: createRng(8) }).toJSON(), fitness: 123, generation: 7 };
    assert.ok(saveChampion(champion, storage));
    assert.ok(store.has(CHAMPION_KEY));
    const loaded = loadChampion(storage);
    assert.equal(loaded.fitness, 123);
    assert.deepEqual(Brain.fromJSON(loaded.brain).network.toGenome(), Brain.fromJSON(champion.brain).network.toGenome());
    clearChampion(storage);
    assert.equal(loadChampion(storage), null);
    assert.equal(loadChampion(null), null);
  });
});
