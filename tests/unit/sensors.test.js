import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Car } from '../../src/car/car.js';
import { fromKmh, m, toMeters } from '../../src/car/units.js';
import { Graph } from '../../src/graph/graph.js';
import { degToRad } from '../../src/math/utils.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { FailureMode, PRESETS } from '../../src/sensors/imperfections.js';
import { RayCaster } from '../../src/sensors/raycast.js';
import { RaySensor } from '../../src/sensors/raySensor.js';
import { SensorStatus } from '../../src/sensors/sensor.js';
import { Simulation } from '../../src/sim/simulation.js';

const DT = 1 / 60;
const HALF_ROAD = 3.3; // m: a two-lane road is 6.6 m wide

/** Player parked in the middle of a long, straight two-lane road. */
function setup() {
  const graph = new Graph();
  const a = graph.addPoint(new Point(-2000, 0));
  const b = graph.addPoint(new Point(2000, 0));
  graph.addSegment(new Segment(a, b, { lanes: 2 }));
  const network = new RoadNetwork(graph);
  network.update();
  const sim = new Simulation(network, { trafficCount: 0 });
  sim.syncRoads();
  sim.player.teleport(0, 0, 0);
  sim.sensors.reset();
  return { sim, suite: sim.sensors };
}

function run(sim, seconds, input) {
  for (let t = 0; t < seconds - 1e-9; t += DT) sim.update(DT, input);
}

function addCar(sim, x, y, angle = 0, speed = 0) {
  const car = new Car({ x: m(x), y: m(y), angle });
  car.state.speed = speed;
  sim.traffic.cars.push(car);
  return car;
}

describe('RayCaster', () => {
  it('returns the nearest border or vehicle along a ray', () => {
    const { sim } = setup();
    const caster = new RayCaster(sim.world);
    const origin = new Point(0, 0);
    caster.prepare(origin, m(50), []);
    const right = caster.cast(origin, Math.PI / 2, m(50));
    assert.equal(right.kind, 'road');
    assert.ok(Math.abs(toMeters(right.distance) - HALF_ROAD) < 1e-6);
    assert.equal(caster.cast(origin, 0, m(50)), null);

    const other = new Car({ x: m(20), y: 0 });
    caster.prepare(origin, m(50), [other]);
    const ahead = caster.cast(origin, 0, m(50));
    assert.equal(ahead.car, other);
    assert.ok(Math.abs(toMeters(ahead.distance) - (20 - 2.2)) < 1e-6);
  });
});

describe('Week 9: ray sensor', () => {
  it('fans its rays symmetrically, and spreads a full circle without repeating a ray', () => {
    const fan = new RaySensor({ rayCount: 5, spread: degToRad(120) }).rayAngles();
    assert.deepEqual(fan.map((a) => Math.round((a * 180) / Math.PI)), [-60, -30, 0, 30, 60]);
    const ring = new RaySensor({ rayCount: 4, spread: Math.PI * 2 }).rayAngles();
    assert.deepEqual(ring.map((a) => Math.round((a * 180) / Math.PI)), [-180, -90, 0, 90]);
  });

  it('measures the distance to road borders and to vehicles', () => {
    const { sim, suite } = setup();
    const rays = suite.get('rays');
    rays.rayCount = 3;
    rays.spread = Math.PI; // left, ahead, right
    addCar(sim, 12, 0);
    run(sim, 0.1);
    const [left, ahead, right] = suite.read('rays').data.rays;
    assert.ok(Math.abs(left.distance - HALF_ROAD) < 1e-6 && left.kind === 'road');
    assert.ok(Math.abs(right.distance - HALF_ROAD) < 1e-6);
    assert.equal(ahead.kind, 'car');
    assert.ok(Math.abs(ahead.distance - (12 - 2.2 - 1.6)) < 1e-6); // bumper minus sensor mount
  });

  it('reports nothing beyond its range', () => {
    const { sim, suite } = setup();
    const rays = suite.get('rays');
    rays.range = 2; // closer than the road edge
    run(sim, 0.1);
    assert.ok(suite.read('rays').data.rays.every((r) => r.distance === null));
  });
});

describe('Week 10: LiDAR', () => {
  it('builds a full revolution of points from streamed packets', () => {
    const { sim, suite } = setup();
    const lidar = suite.get('lidar');
    run(sim, 0.25);
    const scan = suite.read('lidar');
    assert.equal(scan.data.points.length, lidar.raysPerRevolution);
    assert.ok(scan.data.packetPoints < lidar.raysPerRevolution / 2); // streamed in slices
    const angles = new Set(scan.data.points.map((p) => p.angle.toFixed(4)));
    assert.equal(angles.size, lidar.raysPerRevolution);
  });

  it('measures the road edges at the right distance all around the car', () => {
    const { sim, suite } = setup();
    run(sim, 0.25);
    for (const p of suite.read('lidar').data.points) {
      if (p.distance === null) continue;
      // Every return lies on one of the two road edges, y = ±3.3 m.
      assert.ok(Math.abs(Math.abs(p.y) - HALF_ROAD) < 1e-6);
      const s = Math.abs(Math.sin(p.angle));
      if (s > 0.2) assert.ok(Math.abs(p.distance - HALF_ROAD / s) < 1e-6);
    }
  });

  it('can be made much denser', () => {
    const { sim, suite } = setup();
    suite.get('lidar').setResolution({ raysPerRevolution: 1440 });
    run(sim, 0.25);
    assert.equal(suite.read('lidar').data.points.length, 1440);
  });
});

describe('Week 11: radar, GPS, IMU and the common API', () => {
  it('every sensor delivers the same envelope, with metric data', () => {
    const { sim, suite } = setup();
    addCar(sim, 30, 0);
    run(sim, 0.5, { forward: 1 });
    const all = suite.readAll();
    assert.deepEqual(Object.keys(all), ['rays', 'lidar', 'radar', 'gps', 'imu']);
    for (const [name, reading] of Object.entries(all)) {
      assert.equal(reading.sensor, name);
      for (const key of ['type', 'time', 'receivedAt', 'age', 'data']) assert.ok(key in reading, `${name}.${key}`);
      assert.ok(reading.age >= 0 && reading.receivedAt >= reading.time);
    }
  });

  it('radar reports range and closing speed of a vehicle ahead', () => {
    const { sim, suite } = setup();
    const other = addCar(sim, 40, 0, Math.PI, fromKmh(36)); // 10 m/s towards us
    sim.player.state.speed = fromKmh(18); // 5 m/s towards it
    other.input = { forward: 0 };
    run(sim, 0.06);
    const [target] = suite.read('radar').data.targets;
    assert.equal(target.id, other.id);
    assert.ok(Math.abs(target.rangeRate + 15) < 0.6, `range rate ${target.rangeRate}`);
    const gap = toMeters(other.state.x - sim.player.state.x) - 2.2 - 2.2; // bumper to bumper
    assert.ok(Math.abs(target.range - gap) < 0.5);
  });

  it('radar ignores vehicles outside its field of view or hidden behind another', () => {
    const { sim, suite } = setup();
    addCar(sim, -20, 0); // behind
    addCar(sim, 5, 3, 0); // alongside, far outside ±20°
    const near = addCar(sim, 20, 0);
    addCar(sim, 35, 0); // hidden behind `near`
    run(sim, 0.1);
    const targets = suite.read('radar').data.targets;
    assert.deepEqual(targets.map((t) => t.id), [near.id]);
  });

  it('GPS reports the true position when perfect, and no heading when standing still', () => {
    const { sim, suite } = setup();
    sim.player.teleport(m(12), m(-1), 0);
    run(sim, 0.5);
    const fix = suite.read('gps').data;
    assert.ok(Math.abs(fix.x - 12) < 1e-9 && Math.abs(fix.y + 1) < 1e-9);
    assert.equal(fix.heading, null);
    run(sim, 2, { forward: 1 });
    assert.ok(Math.abs(suite.read('gps').data.heading) < 0.01);
  });

  it('IMU measures longitudinal acceleration and yaw rate', () => {
    const { sim, suite } = setup();
    run(sim, 0.5, { forward: 1 });
    const imu = suite.read('imu').data;
    assert.ok(Math.abs(imu.ax - toMeters(sim.player.state.accel)) < 0.1);
    assert.ok(imu.ax > 2);
    run(sim, 1, { forward: 0.3, steer: 1 });
    assert.ok(suite.read('imu').data.yawRate > 0.1); // turning right
  });

  it('each sensor runs at its own rate', () => {
    const { sim, suite } = setup();
    run(sim, 2);
    assert.ok(Math.abs(suite.get('gps').stats.delivered - 10) <= 1); // 5 Hz
    assert.ok(Math.abs(suite.get('radar').stats.delivered - 40) <= 1); // 20 Hz
  });
});

describe('Week 12: imperfections', () => {
  it('realistic GPS wanders by about a metre or two, not millimetres or tens of metres', () => {
    const { sim, suite } = setup();
    suite.setPreset('realistic');
    let sq = 0;
    let n = 0;
    for (let i = 0; i < 60 * 120; i++) {
      sim.update(DT);
      const fix = suite.read('gps');
      if (fix && i % 12 === 0) {
        sq += fix.data.x ** 2 + fix.data.y ** 2;
        n++;
      }
    }
    const rms = Math.sqrt(sq / n);
    assert.ok(rms > 0.8 && rms < 4, `rms ${rms}`);
  });

  it('latency delays every reading', () => {
    const { sim, suite } = setup();
    const gps = suite.get('gps');
    gps.configure({ latency: 0.3 });
    run(sim, 0.25);
    assert.equal(suite.read('gps'), null);
    run(sim, 0.5);
    assert.ok(suite.read('gps').age >= 0.3 - 1e-9);
  });

  it('dropped measurements: whole readings for GPS, single points for the LiDAR', () => {
    const { sim, suite } = setup();
    suite.get('gps').configure({ dropRate: 1 });
    suite.get('lidar').configure({ dropRate: 1 });
    run(sim, 1);
    assert.equal(suite.read('gps'), null);
    assert.ok(suite.read('lidar').data.points.every((p) => p.distance === null));
  });

  it('limited range cuts off far returns', () => {
    const { sim, suite } = setup();
    addCar(sim, 40, 0);
    suite.setKnobs({ range: 0.25 }); // radar 80 m → 20 m
    run(sim, 0.3);
    assert.equal(suite.read('radar').data.targets.length, 0);
    assert.ok(suite.read('lidar').data.points.every((p) => p.distance === null || p.distance <= 12.5));
  });

  it('a dead sensor stops reporting and its last reading grows old', () => {
    const { sim, suite } = setup();
    run(sim, 0.5);
    suite.setFailure('radar', FailureMode.DEAD);
    const before = suite.read('radar').time;
    run(sim, 1);
    assert.equal(suite.get('radar').status, SensorStatus.FAILED);
    assert.equal(suite.read('radar').time, before);
    assert.ok(suite.read('radar').age > 0.9);
  });

  it('a stuck sensor keeps sending the same values with fresh timestamps', () => {
    const { sim, suite } = setup();
    run(sim, 0.5);
    suite.setFailure('gps', FailureMode.STUCK);
    run(sim, 0.4);
    const frozen = suite.read('gps').data;
    run(sim, 2, { forward: 1 }); // the car moves a long way
    const later = suite.read('gps');
    assert.deepEqual(later.data, frozen);
    assert.ok(later.age < 0.25);
  });

  it('an intermittent sensor drops out now and then, but keeps coming back', () => {
    const { sim, suite } = setup();
    suite.setFailure('imu', FailureMode.INTERMITTENT);
    let failedFrames = 0;
    for (let i = 0; i < 60 * 30; i++) {
      sim.update(DT);
      if (suite.get('imu').status === SensorStatus.FAILED) failedFrames++;
    }
    assert.ok(failedFrames > 60 && failedFrames < 60 * 20, `${failedFrames}`);
  });

  it('presets set every knob, and the noise is reproducible with the same seed', () => {
    const readings = [];
    for (let k = 0; k < 2; k++) {
      const { sim, suite } = setup();
      suite.setPreset('degraded');
      assert.deepEqual({ ...suite.knobs }, (({ failures, ...rest }) => rest)(PRESETS.degraded));
      run(sim, 1, { forward: 0.5 });
      readings.push(JSON.stringify(suite.read('imu')?.data));
    }
    assert.equal(readings[0], readings[1]);
  });
});
