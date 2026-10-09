/**
 * Week 23: which car is in which lane, rebuilt every frame.
 *
 * Every car is placed on a carriageway (a road in one direction of travel)
 * with a lane number (0 = right-hand lane) and a distance `s` from the start
 * of the road in that direction. Leaders and followers in any lane are then a
 * sorted-list lookup, which is what lane-change decisions need.
 */
export class LaneIndex {
  constructor(roads = []) {
    this.setRoads(roads);
  }

  setRoads(roads) {
    this.roads = roads;
    this.lists = new Map(); // road → { 1: entries, -1: entries }
  }

  #list(road, dir) {
    let byDir = this.lists.get(road);
    if (!byDir) this.lists.set(road, (byDir = { 1: [], '-1': [] }));
    return byDir[dir];
  }

  /** Place every car; traffic drivers report their own lane, other cars are located geometrically. */
  rebuild(cars) {
    this.lists = new Map();
    for (const car of cars) {
      const info = car.driver?.laneInfo() ?? this.locate(car);
      car.laneInfo = info;
      if (!info) continue;
      for (const lane of info.lanes) this.#list(info.road, info.dir).push({ car, s: info.s, lane });
    }
    for (const byDir of this.lists.values()) for (const list of Object.values(byDir)) list.sort((a, b) => a.s - b.s);
  }

  /** Road, direction and lane under a car that has no driver (the player). */
  locate(car) {
    const p = car.position;
    let best = null;
    for (const road of this.roads) {
      if (!road.poly.containsPoint(p)) continue;
      const seg = road.segment;
      const { offset, point } = seg.projectPoint(p);
      const lateral = seg.direction().perpendicular().dot(p.subtract(point)); // + = right of p1→p2
      const d = Math.abs(lateral);
      if (best && d >= best.d) continue;
      const forward = Math.cos(car.state.angle) * seg.direction().x + Math.sin(car.state.angle) * seg.direction().y;
      const dir = forward >= 0 || road.backwardLanes === 0 ? 1 : -1;
      const len = seg.length();
      const t = Math.min(1, Math.max(0, offset));
      // Lane counted from the right-hand kerb in the direction of travel.
      const fromRightKerb = dir > 0 ? road.width / 2 - lateral : road.width / 2 + lateral;
      const lanes = dir > 0 ? road.forwardLanes : road.backwardLanes;
      const lane = Math.max(0, Math.min(lanes - 1, Math.floor(fromRightKerb / road.laneWidth)));
      best = { d, info: { road, dir, s: dir > 0 ? t * len : (1 - t) * len, lanes: [lane] } };
    }
    return best?.info ?? null;
  }

  /** Nearest car ahead of and behind `s` in a lane: { leader, follower } with bumper gaps. */
  neighbours(road, dir, lane, s, self) {
    const list = this.lists.get(road)?.[dir] ?? [];
    let leader = null;
    let follower = null;
    for (const e of list) {
      if (e.car === self || e.lane !== lane) continue;
      const half = (self.length + e.car.length) / 2;
      if (e.s >= s && (!leader || e.s < leader.s)) leader = { car: e.car, s: e.s, gap: e.s - s - half };
      if (e.s < s && (!follower || e.s > follower.s)) follower = { car: e.car, s: e.s, gap: s - e.s - half };
    }
    return { leader, follower };
  }
}
