import { PhysicsModel, turningRadius } from '../car/physics.js';
import { GRAVITY, toKmh, toMeters } from '../car/units.js';
import { radToDeg } from '../math/utils.js';

/**
 * Dashboard for the player's car plus the labels of the simulation buttons.
 * Refreshed a few times per second, not every frame.
 */
export class Hud {
  constructor(panel, { refreshRate = 12 } = {}) {
    this.panel = panel;
    this.interval = 1 / refreshRate;
    this.timer = 0;
    this.fields = Object.fromEntries(
      [...panel.querySelectorAll('[data-hud]')].map((el) => [el.dataset.hud, el]),
    );
    this.labels = Object.fromEntries(
      [...document.querySelectorAll('[data-label]')].map((el) => [el.dataset.label, el]),
    );
  }

  update(sim, rawDelta, visible) {
    this.panel.hidden = !visible;
    this.timer += rawDelta;
    if (this.timer < this.interval) return;
    this.timer = 0;

    this.labels.model.textContent = sim.model === PhysicsModel.REALISTIC ? 'Realistic' : 'Basic';
    this.labels.weather.textContent = sim.roadSurface.name.split(' ')[0];
    this.labels.traffic.textContent = sim.traffic.cars.length;
    if (!visible) return;

    const car = sim.player;
    const s = car.state;
    const kmh = toKmh(s.speed);
    const radius = turningRadius(car.params, s.steer);
    const set = (key, value) => {
      if (this.fields[key].textContent !== value) this.fields[key].textContent = value;
    };

    set('speed', Math.abs(kmh).toFixed(0));
    set('gear', s.reversing ? 'R' : Math.abs(kmh) < 0.5 ? 'N' : 'D');
    set('steer', `${radToDeg(s.steer).toFixed(1)}°`);
    set('radius', Number.isFinite(radius) && Math.abs(s.steer) > 0.005 ? `${toMeters(radius).toFixed(1)} m` : '∞');
    set('lateral', `${(Math.abs(s.lateralAccel) / GRAVITY).toFixed(2)} g`);
    set('surface', `${car.surface.name} (μ ${car.surface.grip})`);
    set('model', sim.model === PhysicsModel.REALISTIC ? 'Bicycle model' : 'Basic');
    set('hits', String(car.collisionCount));
    set('driver', sim.autopilot ? 'Autopilot' : 'You');
    const city = sim.city;
    set('limit', city?.playerLimit ? `${city.playerLimit} km/h${city.playerSpeeding ? ' · too fast!' : ''}` : '–');
    set('violations', city ? `${city.violations.redLights} red · ${city.violations.speedingTime.toFixed(0)} s speeding` : '–');
    this.panel.classList.toggle('speeding', !!city?.playerSpeeding);

    const lock = car.params.maxSteer;
    this.fields.steerbar.style.setProperty('--steer', (s.steer / lock).toFixed(3));
    this.panel.classList.toggle('sliding', s.sliding);
    this.panel.classList.toggle('braking', s.braking);
    this.panel.classList.toggle('hit', car.colliding);
  }
}
