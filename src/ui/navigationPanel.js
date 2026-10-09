import { AutonomousDriver } from '../autonomy/autonomousDriver.js';
import { toKmh, toMeters } from '../car/units.js';
import { findRoute } from '../navigation/pathfinding.js';
import { Route } from '../navigation/route.js';

const TURN_ICONS = { start: '●', left: '↰', right: '↱', straight: '↑', exit: '↘', merge: '↗', arrive: '⚑' };

/**
 * Navigate mode: click START and DESTINATION on the map, get a route (A* or
 * Dijkstra, fastest or shortest) with turn-by-turn directions, then let the
 * autonomous car drive it while every layer of its stack is shown live.
 */
export class NavigationPanel {
  constructor(panel, sim) {
    this.panel = panel;
    this.sim = sim;
    this.start = null;
    this.goal = null;
    this.route = null;
    this.comparison = null;
    this.timer = 0;
    this.$ = (sel) => panel.querySelector(sel);
    this.#bind();
    this.#render();
  }

  get visible() {
    return !this.panel.hidden;
  }

  show(visible) {
    this.panel.hidden = !visible;
  }

  get driving() {
    return this.sim.autonomy?.status === 'driving';
  }

  #bind() {
    for (const sel of ['[data-nav="algorithm"]', '[data-nav="mode"]']) this.$(sel).addEventListener('change', () => this.#plan());
    this.$('[data-nav="fromCar"]').addEventListener('change', () => {
      if (this.$('[data-nav="fromCar"]').checked) this.#startFromCar();
      this.#plan();
    });
    this.$('[data-nav-action="go"]').addEventListener('click', () => this.drive());
    this.$('[data-nav-action="stop"]').addEventListener('click', () => this.stopDriving());
    this.$('[data-nav-action="clear"]').addEventListener('click', () => this.clear());
  }

  /** A click on the map (world point). */
  click(point) {
    const nav = this.sim.nav;
    if (!nav || this.driving) return;
    const match = nav.match(point);
    if (!match) {
      this.message = 'Click on a road.';
      this.#render();
      return;
    }
    const fromCar = this.$('[data-nav="fromCar"]').checked;
    if (fromCar) {
      this.#startFromCar();
      this.goal = match;
    } else if (!this.start || this.goal) {
      this.start = match;
      this.goal = null;
      this.route = null;
    } else {
      this.goal = match;
    }
    this.message = '';
    this.#plan();
  }

  #startFromCar() {
    const car = this.sim.player;
    this.start = this.sim.nav?.match(car.position, car.state.angle) ?? null;
  }

  #plan() {
    this.route = null;
    this.comparison = null;
    if (this.start && this.goal && this.sim.nav) {
      const options = { algorithm: this.$('[data-nav="algorithm"]').value, mode: this.$('[data-nav="mode"]').value };
      this.route = Route.find(this.sim.nav, this.start, this.goal, options);
      const other = options.algorithm === 'astar' ? 'dijkstra' : 'astar';
      const alt = findRoute(this.sim.nav, this.start, this.goal, { ...options, algorithm: other });
      this.comparison = alt ? { [other]: alt.expanded, [options.algorithm]: this.route?.result.expanded } : null;
      if (!this.route) this.message = 'No route between those points (one-way streets?).';
    }
    this.#render();
  }

  drive() {
    if (!this.route) return;
    const sim = this.sim;
    if (!this.$('[data-nav="fromCar"]').checked) {
      const p = this.route.path.pointAt(this.route.sStart);
      sim.player.teleport(p.x, p.y, this.route.path.tangentAt(this.route.sStart).angle());
    }
    sim.disableAutopilot();
    sim.startAutonomy(new AutonomousDriver({
      car: sim.player,
      route: this.route,
      city: sim.city,
      sensors: sim.sensors,
      perception: this.$('[data-nav="perception"]').value,
    }));
    this.#render();
  }

  stopDriving() {
    this.sim.stopAutonomy();
    this.#render();
  }

  clear() {
    this.stopDriving();
    this.sim.autonomy = null;
    this.start = this.goal = this.route = null;
    this.message = '';
    this.#render();
  }

  /** Forget everything when the road network changes. */
  reset() {
    this.clear();
  }

  update(rawDelta) {
    if (!this.visible) return;
    this.timer += rawDelta;
    if (this.timer < 0.15) return;
    this.timer = 0;
    this.#renderLive();
  }

  #render() {
    const step = !this.start ? 'Click a road to set the <b>START</b>.' : !this.goal ? 'Now click the <b>DESTINATION</b>.' : '';
    this.$('[data-nav-status]').innerHTML = this.message || step || (this.route ? 'Route found. Drive it, or click again to start over.' : '');
    const summary = this.$('[data-nav-summary]');
    const list = this.$('[data-nav-steps]');
    if (this.route) {
      const r = this.route;
      const c = this.comparison ?? {};
      summary.innerHTML = `
        <div><b>${(r.distance / 1000).toFixed(2)} km</b> · about ${Math.round(r.time / 6) / 10} min · ${r.edges.length} road segments</div>
        <div class="muted">A* explored ${c.astar ?? '–'} edges · Dijkstra ${c.dijkstra ?? '–'}</div>`;
      list.innerHTML = r.instructions
        .map((i) => `<li><span class="icon">${TURN_ICONS[i.turn] ?? '•'}</span>${i.text}<span class="muted"> · ${Math.round(toMeters(i.s - r.sStart))} m</span></li>`)
        .join('');
    } else {
      summary.innerHTML = '';
      list.innerHTML = '';
    }
    this.$('[data-nav-action="go"]').disabled = !this.route || this.driving;
    this.$('[data-nav-action="stop"]').disabled = !this.driving;
    this.#renderLive();
  }

  #renderLive() {
    const ad = this.sim.autonomy;
    const live = this.$('[data-nav-live]');
    live.hidden = !ad;
    this.$('[data-nav-action="go"]').disabled = !this.route || this.driving;
    this.$('[data-nav-action="stop"]').disabled = !this.driving;
    if (!ad) return;
    const d = ad.decision;
    const best = ad.planner.best;
    const ctrl = ad.controller.output;
    const set = (key, html) => (this.$(`[data-layer="${key}"]`).innerHTML = html);
    set('route', d ? d.instruction : '–');
    set('behavior', d ? `<b>${d.state}</b> · ${d.text}` : '–');
    const feasible = ad.planner.candidates.filter((c) => c.feasible).length;
    set(
      'trajectory',
      best
        ? `${feasible}/${ad.planner.candidates.length} safe · chose <b>${best.kind}</b>${best.kind === 'speed' ? ` → ${Math.round(toKmh(best.target))} km/h` : ''}${d && Math.abs(best.dT) > 1 ? ' · lane change' : ''}`
        : '–',
    );
    set(
      'controller',
      `steer ${(ctrl.steer * 100).toFixed(0)}% · throttle ${(ctrl.forward * 100).toFixed(0)}% · brake ${(ctrl.back * 100).toFixed(0)}% · ${Math.round(toKmh(this.sim.player.speed))} km/h`,
    );
    set('perception', `${ad.perception.objects.length} objects tracked (${ad.perception.mode === 'sensors' ? 'LiDAR + radar' : 'ground truth'})`);
    this.$('[data-nav-progress]').style.width = `${(ad.progress * 100).toFixed(1)}%`;
    const s = ad.stats;
    this.$('[data-nav-result]').innerHTML =
      ad.status === 'driving'
        ? `${Math.round(s.distance)} m driven · ${Math.round(s.time)} s · ${Math.round(this.route ? this.route.remaining(ad.s) : 0)} m to go`
        : `<b>${ad.status === 'arrived' ? 'Arrived' : 'Stopped'}</b> after ${Math.round(s.time)} s and ${Math.round(s.distance)} m · max ${Math.round(toKmh(s.maxSpeed))} km/h · ${ad.collisions} collisions · ${ad.redLights} red lights`;
  }

  /** Map overlay: explored edges, the route, start and destination. */
  draw(ctx, px) {
    const nav = this.sim.nav;
    if (this.route && !this.sim.autonomy) {
      ctx.strokeStyle = 'rgba(255, 159, 10, 0.35)';
      ctx.lineWidth = 2 * px;
      for (const id of this.route.result.visited ?? []) {
        const e = nav.edges[id];
        ctx.beginPath();
        ctx.moveTo(e.fromPoint.x, e.fromPoint.y);
        ctx.lineTo(e.toPoint.x, e.toPoint.y);
        ctx.stroke();
      }
      this.route.draw(ctx, px);
    }
    const pin = (match, color, label) => {
      if (!match) return;
      const p = match.point;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(9, 9 * px), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
      ctx.font = `bold ${12 * px}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.fillText(label, p.x + 14 * px, p.y - 10 * px);
    };
    pin(this.start, '#30d158', 'START');
    pin(this.goal, '#ff453a', 'DESTINATION');
  }
}
