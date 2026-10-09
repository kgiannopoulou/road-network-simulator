import { m } from '../car/units.js';
import { Point } from '../primitives/point.js';

const CLUSTER_GAP = m(1.6); // LiDAR returns closer than this belong to one object
const GATE = m(3.5); // association distance between a detection and a track
const FORGET_AFTER = 0.6; // s without a detection
const ALPHA = 0.3; // alpha-beta filter gains (updated every frame, so small)
const BETA = 0.03;

/**
 * What the autonomous car believes is around it: a list of tracked objects
 * { id, x, y, vx, vy, radius, age, source } in world units.
 *
 *   'sensors'       built only from Phase 3 readings: LiDAR returns that hit
 *                   a vehicle are clustered into objects, radar targets are
 *                   added, and an alpha-beta filter tracks each object over
 *                   time to estimate its velocity
 *   'groundTruth'   the simulation's real cars nearby (for comparison)
 */
export class Perception {
  constructor({ mode = 'sensors', range = m(60) } = {}) {
    this.mode = mode;
    this.range = range;
    this.tracks = [];
    this.nextId = 1;
    this.lastTime = null;
    this.detections = [];
  }

  get objects() {
    return this.tracks;
  }

  update(time, { car, sensors, cars = [] }) {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    if (this.mode === 'groundTruth') {
      this.tracks = cars
        .filter((c) => c !== car && c.position.distanceTo(car.position) < this.range)
        .map((c) => {
          const v = c.velocity;
          return { id: c.id, x: c.state.x, y: c.state.y, vx: v.x, vy: v.y, radius: c.length / 2, age: 1, source: 'truth' };
        });
      return this.tracks;
    }
    this.detections = this.#detect(car, sensors);
    this.#track(this.detections, dt, time);
    return this.tracks;
  }

  /** Object centres from LiDAR clusters and radar targets. */
  #detect(car, sensors) {
    const ego = car.position;
    const points = [];
    const lidar = sensors?.read('lidar');
    for (const p of lidar?.data.points ?? []) {
      if (p.distance !== null && p.kind === 'car') points.push(new Point(m(p.x), m(p.y)));
    }
    const clusters = cluster(points);
    const detections = clusters.map((c) => {
      // Returns lie on the near surface: push the centre ~1 m further away.
      const centre = c.reduce((a, p) => a.add(p), new Point(0, 0)).scale(1 / c.length);
      const away = centre.subtract(ego).normalize();
      return { point: centre.add(away.scale(m(1))), source: 'lidar' };
    });
    const radar = sensors?.read('radar');
    for (const t of radar?.data.targets ?? []) {
      const p = new Point(m(t.x), m(t.y));
      const away = p.subtract(ego).normalize();
      const point = p.add(away.scale(m(1.2)));
      if (!detections.some((d) => d.point.distanceTo(point) < m(2))) detections.push({ point, source: 'radar' });
    }
    return detections;
  }

  #track(detections, dt, time) {
    const used = new Set();
    // Predict, then associate greedily by distance.
    for (const track of this.tracks) {
      const predicted = new Point(track.x + track.vx * dt, track.y + track.vy * dt);
      let best = null;
      detections.forEach((d, i) => {
        if (used.has(i)) return;
        const dist = d.point.distanceTo(predicted);
        if (dist < GATE && (!best || dist < best.dist)) best = { i, dist };
      });
      if (best) {
        used.add(best.i);
        const r = detections[best.i].point.subtract(predicted);
        track.x = predicted.x + ALPHA * r.x;
        track.y = predicted.y + ALPHA * r.y;
        if (dt > 0) {
          track.vx += (BETA * r.x) / dt;
          track.vy += (BETA * r.y) / dt;
        }
        track.seen = time;
        track.age++;
        track.source = detections[best.i].source;
      } else {
        track.x = predicted.x;
        track.y = predicted.y;
      }
    }
    this.tracks = this.tracks.filter((t) => time - t.seen < FORGET_AFTER);
    detections.forEach((d, i) => {
      if (used.has(i)) return;
      this.tracks.push({ id: this.nextId++, x: d.point.x, y: d.point.y, vx: 0, vy: 0, radius: m(2.2), age: 1, seen: time, source: d.source });
    });
  }

  draw(ctx, px) {
    for (const t of this.tracks) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2);
      ctx.strokeStyle = t.age > 3 ? 'rgba(255, 159, 10, 0.9)' : 'rgba(255, 159, 10, 0.4)';
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + t.vx, t.y + t.vy); // one second ahead
      ctx.stroke();
    }
  }
}

/** Single-linkage clustering of points closer than CLUSTER_GAP. */
function cluster(points) {
  const clusters = [];
  const seen = new Set();
  for (let i = 0; i < points.length; i++) {
    if (seen.has(i)) continue;
    const group = [points[i]];
    seen.add(i);
    for (let k = 0; k < group.length; k++) {
      for (let j = 0; j < points.length; j++) {
        if (!seen.has(j) && group[k].distanceTo(points[j]) < CLUSTER_GAP) {
          seen.add(j);
          group.push(points[j]);
        }
      }
    }
    if (group.length >= 2) clusters.push(group);
  }
  return clusters;
}
