import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  brakingDistance,
  createCarParams,
  createCarState,
  maxSteerAt,
  PhysicsModel,
  step,
  stepBasic,
  stepRealistic,
  SURFACES,
} from '../../src/car/physics.js';
import { fromKmh, GRAVITY, m, toKmh } from '../../src/car/units.js';

const DT = 1 / 120;
const params = createCarParams();

function run(state, input, seconds, { surface = SURFACES.dry, model = PhysicsModel.REALISTIC, onStep } = {}) {
  for (let t = 0; t < seconds; t += DT) {
    step(model, state, input, params, surface, DT);
    onStep?.(state);
  }
  return state;
}

function moving(kmh) {
  const state = createCarState();
  state.speed = fromKmh(kmh);
  return state;
}

describe('units', () => {
  it('converts km/h and metres both ways', () => {
    assert.ok(Math.abs(toKmh(fromKmh(50)) - 50) < 1e-9);
    assert.ok(Math.abs(m(3.3) - 22) < 1e-9); // one lane
  });
});

describe('Week 5: basic car', () => {
  it('accelerates, is capped at top speed and coasts to a stop without reversing', () => {
    const s = createCarState();
    let last = 0;
    run(s, { forward: 1 }, 3, {
      model: PhysicsModel.BASIC,
      onStep: (st) => {
        assert.ok(st.speed >= last);
        last = st.speed;
      },
    });
    assert.ok(s.speed > 0 && s.x > 0);
    run(s, { forward: 1 }, 120, { model: PhysicsModel.BASIC });
    assert.ok(s.speed <= params.maxSpeed);
    run(s, {}, 120, { model: PhysicsModel.BASIC });
    assert.equal(s.speed, 0);
  });

  it('brakes, then reverses up to the reverse speed limit', () => {
    const s = moving(30);
    run(s, { back: 1 }, 20, { model: PhysicsModel.BASIC });
    assert.ok(s.speed < 0);
    assert.ok(s.speed >= -params.maxReverse);
  });

  it('turns at the same rate at any speed: the "rectangle" behaviour week 6 fixes', () => {
    const slow = moving(1);
    const fast = moving(60);
    stepBasic(slow, { forward: 1, steer: 1 }, params, DT);
    stepBasic(fast, { forward: 1, steer: 1 }, params, DT);
    assert.ok(Math.abs(slow.yawRate - fast.yawRate) < 1e-9);
  });
});

describe('Week 6: bicycle model', () => {
  it('reaches 100 km/h in a believable time and tops out below the limit', () => {
    const s = createCarState();
    let t100 = null;
    let t = 0;
    run(s, { forward: 1 }, 60, {
      onStep: (st) => {
        t += DT;
        if (t100 === null && toKmh(st.speed) >= 100) t100 = t;
      },
    });
    assert.ok(t100 > 8 && t100 < 25, `0-100 km/h took ${t100}s`);
    assert.ok(s.speed < params.maxSpeed);
  });

  it('stops within the braking distance the grip allows', () => {
    const s = moving(50);
    run(s, { back: 1, allowReverse: false }, 10);
    const expected = brakingDistance(params, fromKmh(50));
    assert.equal(s.speed, 0);
    assert.ok(Math.abs(s.x - expected) / expected < 0.05, `${s.x} vs ${expected}`);
  });

  it('needs several times the distance to stop on ice', () => {
    const dry = run(moving(50), { back: 1, allowReverse: false }, 20);
    const icy = run(moving(50), { back: 1, allowReverse: false }, 60, { surface: SURFACES.icy });
    assert.ok(icy.x > dry.x * 4);
  });

  it('holds still with allowReverse: false, reverses (capped) otherwise', () => {
    const held = run(createCarState(), { back: 1, allowReverse: false }, 3);
    assert.equal(held.speed, 0);
    const reversing = run(createCarState(), { back: 1 }, 30);
    assert.ok(reversing.speed < 0 && reversing.speed >= -params.maxReverse);
    assert.ok(reversing.reversing);
  });

  it('rolls to a stop when coasting, and friction never reverses the car', () => {
    const s = moving(40);
    let min = Infinity;
    run(s, {}, 300, { onStep: (st) => (min = Math.min(min, st.speed)) });
    assert.equal(s.speed, 0);
    assert.ok(min >= 0);
  });

  it('turns the wheels at a limited rate', () => {
    const s = moving(5);
    stepRealistic(s, { steer: 1 }, params, SURFACES.dry, 0.05);
    assert.ok(s.steer <= params.steerRate * 0.05 + 1e-9);
    run(s, { steer: 1, forward: 0.1 }, 2);
    assert.ok(Math.abs(s.steer - maxSteerAt(params, s.speed)) < 0.02);
  });

  it('has less steering lock at speed', () => {
    assert.ok(maxSteerAt(params, fromKmh(100)) < maxSteerAt(params, 0) / 2);
  });

  it('drives a circle of radius √((L/tan δ)² + (L/2)²) at low speed', () => {
    const s = createCarState();
    let minX = Infinity;
    let maxX = -Infinity;
    // Creep forward with full lock for a few laps.
    run(s, { forward: 0.05, steer: 1 }, 2);
    run(s, { forward: 0.05, steer: 1 }, 40, {
      onStep: (st) => {
        if (toKmh(st.speed) > 8) st.speed = fromKmh(8);
        minX = Math.min(minX, st.x);
        maxX = Math.max(maxX, st.x);
      },
    });
    const L = params.wheelbase;
    const expected = Math.hypot(L / Math.tan(s.steer), L / 2);
    const measured = (maxX - minX) / 2;
    assert.ok(Math.abs(measured - expected) / expected < 0.03, `${measured} vs ${expected}`);
  });

  it('never exceeds the tyre grip in a corner: it understeers and reports sliding', () => {
    for (const surface of [SURFACES.dry, SURFACES.icy]) {
      const s = moving(90);
      let peak = 0;
      run(s, { steer: 1 }, 1, {
        surface,
        onStep: (st) => {
          peak = Math.max(peak, Math.abs(st.lateralAccel));
          st.speed = fromKmh(90);
        },
      });
      assert.ok(peak <= surface.grip * GRAVITY + 1e-6);
      assert.ok(s.sliding);
    }
  });
});
