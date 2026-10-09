import { toMeters } from '../car/units.js';

/**
 * Week 26: shortest paths on the NavGraph.
 *
 * The search runs over *edges* rather than nodes, so turn restrictions are
 * part of the graph (from edge A you can only continue to A's transitions)
 * and turns can carry a cost.
 *
 *   dijkstra(...)   explores in order of cost so far
 *   astar(...)      adds an admissible estimate of the cost to go: the
 *                   straight-line distance (shortest) or that distance at the
 *                   network's top speed (fastest), so it explores far fewer
 *                   edges and still finds an optimal route
 */
export const COST_MODES = {
  fastest: { label: 'Fastest', unit: 's' },
  shortest: { label: 'Shortest', unit: 'm' },
};

export const TURN_PENALTY = { left: 8, right: 3, straight: 0, merge: 0, exit: 2 }; // s (fastest only)
const SIGNAL_PENALTY = 10; // s: expected wait at lights
const STOP_PENALTY = 5; // s: stop or yield sign

/** Binary min-heap of { key, value }. */
export class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(key, value) {
    const a = this.items;
    a.push({ key, value });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key <= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l].key < a[s].key) s = l;
        if (r < a.length && a[r].key < a[s].key) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/** Cost of driving `metres` of an edge. */
function edgeCost(edge, metres, mode) {
  return mode === 'shortest' ? metres : metres / edge.speed;
}

function transitionCost(t, mode) {
  if (mode === 'shortest') return 0;
  return (TURN_PENALTY[t.turn] ?? 0) + (t.signals ? SIGNAL_PENALTY : t.controlled ? STOP_PENALTY : 0);
}

/**
 * Best route from `start` to `goal`, each { edge, s } (s in metres along the
 * edge), e.g. from NavGraph.match(). Returns { edges, transitions, cost,
 * distance, time, expanded, algorithm } or null when there is no route.
 */
export function findRoute(graph, start, goal, { algorithm = 'astar', mode = 'fastest' } = {}) {
  const goalPoint = goal.edge.fromPoint.add(goal.edge.toPoint.subtract(goal.edge.fromPoint).scale(goal.s / goal.edge.length));
  const heuristic = (edge) => {
    if (algorithm !== 'astar') return 0;
    const metres = toMeters(edge.toPoint.distanceTo(goalPoint));
    return mode === 'shortest' ? metres : metres / graph.maxSpeed;
  };

  // Same edge, goal ahead of start: no search needed.
  if (start.edge === goal.edge && goal.s >= start.s) {
    const d = goal.s - start.s;
    return finish(graph, [start.edge], [], d, edgeCost(start.edge, d, mode), 1, algorithm, start, goal);
  }

  const best = new Map(); // edge id → cost to reach the end of the edge
  const previous = new Map(); // edge id → { from, transition }
  const heap = new MinHeap();
  const first = edgeCost(start.edge, start.edge.length - start.s, mode);
  best.set(start.edge.id, first);
  heap.push(first + heuristic(start.edge), { id: start.edge.id, g: first });
  let bestGoal = Infinity; // cost of the best complete route found so far
  let goalPrevious = null;
  let expanded = 0;
  const visited = []; // edges in the order they were expanded (for drawing the search)

  while (heap.size) {
    const { key, value } = heap.pop();
    if (key >= bestGoal) break; // nothing left can beat it
    if (value.g > best.get(value.id)) continue; // stale entry
    expanded++;
    const edge = graph.edges[value.id];
    visited.push(edge.id);
    for (const t of edge.transitions) {
      const next = graph.edges[t.to];
      const base = value.g + transitionCost(t, mode);
      // Arriving: only the first goal.s metres of the goal edge are driven.
      if (next.id === goal.edge.id) {
        const total = base + edgeCost(next, goal.s, mode);
        if (total < bestGoal) {
          bestGoal = total;
          goalPrevious = { from: edge.id, transition: t };
        }
      }
      const full = base + edgeCost(next, next.length, mode);
      if (full < (best.get(next.id) ?? Infinity)) {
        best.set(next.id, full);
        previous.set(next.id, { from: edge.id, transition: t });
        heap.push(full + heuristic(next), { id: next.id, g: full });
      }
    }
  }
  if (!goalPrevious) return null;

  const edges = [goal.edge];
  const transitions = [goalPrevious.transition];
  let id = goalPrevious.from;
  edges.unshift(graph.edges[id]);
  while (id !== start.edge.id) {
    const p = previous.get(id);
    transitions.unshift(p.transition);
    id = p.from;
    edges.unshift(graph.edges[id]);
  }
  let distance = start.edge.length - start.s + goal.s;
  for (let i = 1; i < edges.length - 1; i++) distance += edges[i].length;
  const result = finish(graph, edges, transitions, distance, bestGoal, expanded, algorithm, start, goal);
  result.visited = visited;
  return result;
}

function finish(graph, edges, transitions, distance, cost, expanded, algorithm, start, goal) {
  let time = 0;
  edges.forEach((edge, i) => {
    const from = i === 0 ? start.s : 0;
    const to = i === edges.length - 1 ? goal.s : edge.length;
    time += Math.max(0, to - from) / edge.speed;
  });
  for (const t of transitions) time += transitionCost(t, 'fastest');
  return { edges, transitions, distance, time, cost, expanded, algorithm, start, goal };
}
