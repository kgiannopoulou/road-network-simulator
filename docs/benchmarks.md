# A* vs Dijkstra

`node tools/bench-pathfinding.mjs` (CI runs it too, and fails if the two ever disagree on a route's
cost). 300 random routes per row from a seeded RNG, the median per query; Node 24 on an AMD Ryzen 7
5800H. The networks are the Phase 6 city and square grids of 120 m blocks with 5 % of roads missing
and 15 % one-way, also seeded.

Both algorithms run the same edge-based search (`navigation/pathfinding.js`); A* adds a heuristic:
the straight-line distance to the destination (*shortest*) or that distance at the network's top
speed (*fastest*).

| Network | Directed edges | Cost | Dijkstra expanded | A* expanded | Fewer edges | Dijkstra time | A* time | Speed-up | Same cost |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| City (Phase 6 map) | 70 | shortest | 25 | 10 | 40% | 12.2 µs | 6.9 µs | 1.8× | ✓ 247/247 |
| City (Phase 6 map) | 70 | fastest | 28 | 21 | 17% | 12.6 µs | 16.0 µs | 0.8× | ✓ 247/247 |
| Grid 10×10 | 313 | shortest | 124 | 20 | 73% | 34.7 µs | 9.0 µs | 3.9× | ✓ 299/299 |
| Grid 10×10 | 313 | fastest | 137 | 50 | 51% | 37.6 µs | 19.6 µs | 1.9× | ✓ 299/299 |
| Grid 20×20 | 1,333 | shortest | 618 | 97 | 75% | 151.6 µs | 36.8 µs | 4.1× | ✓ 297/297 |
| Grid 20×20 | 1,333 | fastest | 628 | 253 | 50% | 187.8 µs | 91.2 µs | 2.1× | ✓ 297/297 |
| Grid 30×30 | 3,034 | shortest | 1,404 | 230 | 74% | 365.6 µs | 82.5 µs | 4.4× | ✓ 298/298 |
| Grid 30×30 | 3,034 | fastest | 1,401 | 600 | 49% | 539.0 µs | 221.0 µs | 2.4× | ✓ 298/298 |
| Grid 40×40 | 5,441 | shortest | 2,599 | 450 | 72% | 679.6 µs | 160.8 µs | 4.2× | ✓ 299/299 |
| Grid 40×40 | 5,441 | fastest | 2,562 | 1,078 | 48% | 1,018.0 µs | 555.4 µs | 1.8× | ✓ 299/299 |

"Expanded" columns are medians; "fewer edges" compares the means. Rows don't reach 300/300 because
some random pairs have no legal route (one-way streets, no U-turns); both algorithms agree on those
too.

## What the numbers say

- **Same answers, always.** Every reachable pair gets a route of identical cost from both, as it
  must with an admissible heuristic. `tests/unit/edge-cases.test.js` checks the same on 40 random
  networks in every CI run.
- **For the shortest route A\* expands ~75 % fewer edges and is ~4× faster** on grids, and the gap
  holds as the network grows: Dijkstra's search is a disc around the start, A*'s an ellipse towards
  the goal.
- **For the fastest route A\* helps half as much.** Its heuristic assumes the whole remaining trip at
  the network's top speed (the highway) with no turn or signal penalties, so on city streets it
  underestimates the remaining time by a lot and guides the search less. A tighter admissible
  estimate (e.g. landmarks / ALT) would close that gap.
- **On the 70-edge city map the heuristic costs more than it saves** for *fastest* (0.8×): when the
  search is only ~28 edges, computing a distance per push outweighs the edges skipped. At this size
  either algorithm answers in ~15 µs, far below one 16 ms frame.

## Edge cases tested

`tests/unit/edge-cases.test.js`:

- disconnected networks (no route either way, by either algorithm, for either cost) — and routes
  still found within each island
- a destination behind the car on a dead-end street (no U-turns: unreachable) versus on a loop
  (drives round the block)
- empty maps and maps of lone nodes
- degenerate and duplicate (reversed) roads rejected by the graph
- parallel, collinear, zero-length and nearly parallel segment intersections
- collisions: identical shapes, a shape inside another (and the push separating them), shapes that
  only touch, a rotated car clipping a corner, spatial-hash items exactly on a cell boundary
