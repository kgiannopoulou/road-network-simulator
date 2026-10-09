# Road Network Simulator

A 2D road network simulator built from scratch with plain HTML, CSS and JavaScript ES modules on a single `<canvas>`. There is no framework, no bundler and no runtime dependencies.

This repository holds **Phase 1: the simulator foundation**. It covers the engine, a geometry library, an editable road graph, and procedural road generation with lanes, centre lines and direction arrows.

![Road network editor](docs/screenshot-roads.png)

## Quick start

ES modules don't load from `file://`, so serve the folder over HTTP:

```bash
npm start                     # npx http-server on http://localhost:8080
# or
python -m http.server 8080
```

| Page | URL |
| --- | --- |
| Simulator | `http://localhost:8080/` |
| Geometry visual tests | `http://localhost:8080/tests/visual/` |

```bash
npm test                      # unit tests (Node ≥ 22, built-in node:test, no installs)
```

## Phase 1 roadmap

| Week | Goal | Status |
| --- | --- | --- |
| 1 | **Project + Canvas engine:** game loop, delta time, camera, mouse/keyboard input, FPS counter, debug tools | ✅ |
| 2 | **Geometry library:** Point, Segment, Polygon, vector maths, `lerp()`, distances, line and polygon intersections, rotations, transformations | ✅ |
| 3 | **Road graph:** add, remove, move and connect nodes; build networks by hand | ✅ |
| 4 | **Road generation:** width, borders, centre lines, lane markings, lane count and direction; connected segments | ✅ |

### Week 1: Canvas engine (`src/engine/`)

- **`GameLoop`** runs on `requestAnimationFrame` with variable delta time in seconds. Delta is clamped so a backgrounded tab can't produce a huge step. It also has a `timeScale` for slow motion or pause.
- **`Camera`** maps world coordinates to the screen through an affine `Matrix`. It supports pan, zoom-at-cursor, fit-to-bounds and visible-bounds queries, and handles `devicePixelRatio` for sharp rendering on HiDPI screens.
- **`Input`** uses polling. DOM events only record state, and game code reads it inside `update()`. It provides `isDown` / `wasPressed` / `wasReleased` for keys and mouse buttons, mouse delta, and normalised wheel delta. `endFrame()` clears the per-frame flags.
- **Debug tools:** a smoothed FPS counter with frame time and worst frame, a live stats overlay (`F3`), an adaptive infinite grid with world axes, and a geometry debug view (`B`) that shows envelopes, vertices and bounding boxes.

### Week 2: Geometry library (`src/math/`, `src/primitives/`)

| Module | What it does |
| --- | --- |
| `utils.js` | `lerp`, `inverseLerp`, `clamp`, `snap`, segment–segment and line–line intersection (with parameters along both), bounding-box overlap |
| `Point` | Vector maths: add, subtract, scale, dot, cross, length, normalise, perpendicular, angle, distance, rotate (around any pivot), translate by angle |
| `Segment` | Length, direction, projection, distance to point, intersection, parallel offset, undirected equality |
| `Polygon` | Point containment (ray casting), polygon–polygon intersection, area, centroid, matrix transform, and **union outline** (break edges at crossings, keep the outer pieces) |
| `Matrix` | Immutable 2D affine transform: translate, rotate, rotate around a pivot, scale, multiply, invert, apply to points or set on a canvas |
| `Envelope` | Capsule polygon around a segment: the surface of a road |

Every function has a **visual test** in `tests/visual/`. Each card is interactive and checks an invariant live, so a regression shows up as ✗:

![Visual tests](docs/screenshot-visual-tests.png)

### Week 3: Road graph (`src/graph/`)

```
Point ───── Segment ───── Point
                          │
                          │
                        Point
```

- **`Graph`** stores nodes as `Point`s and edges as `Segment`s. Edges reference the node instances themselves, so moving a node moves every connected road. It rejects duplicate nodes and edges (in either direction). Removing a node removes its edges. It also supports splitting an edge, nearest-node and nearest-edge picking, and JSON serialisation. A `version` counter tells consumers when to rebuild.
- **`GraphEditor`** builds the network with the mouse: place, connect, drag, split and delete. It has optional grid snapping.
- **Persistence:** the network autosaves to `localStorage`, and you can export or import it as JSON.

### Week 4: Road generation (`src/road/`)

Each edge carries `lanes` and `oneWay`. `RoadNetwork` turns the graph into road geometry and only rebuilds when the graph's version changes:

1. **Surface:** each edge gets an `Envelope` that is `lanes × laneWidth` wide, with rounded caps so roads blend at shared nodes.
2. **Borders:** the outline of the **union** of all envelopes. Connected roads become one surface with no internal edges, however many roads meet at a node.
3. **Lane layout:** traffic drives on the right. Forward lanes (p1 → p2) sit right of the skeleton and backward lanes sit left; an odd lane count gives the extra lane to the forward direction. One-way roads put every lane forward and have no centre line.
4. **Markings:** a double yellow centre line separates the two directions, and dashed white lines separate lanes going the same way.
   - At **junctions**, markings are clipped where they enter another road's surface.
   - Through **simple bends** (a degree-2 node with the same lane layout), markings are mitred so they join without a gap.
5. **Direction arrows:** each lane gets arrows at regular intervals. They are placed by transforming an arrow template polygon with a `Matrix`.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows | Move camera |
| Mouse wheel | Zoom at cursor |
| Middle drag, or `Space` + drag | Pan |
| `F` / `0` | Fit network / reset view |
| `1` / `2` | Graph mode / Roads mode |

**Graph mode**

| Input | Action |
| --- | --- |
| Click empty space | Add a node (connected to the selected node) |
| Click a road | Split it with a new node (`Shift` to place a free node instead) |
| Click / drag a node | Select it, connect the selection to it, or move it |
| Right click | Deselect, or delete the hovered node or edge |
| `Del` / `Esc` | Delete the selected node / deselect |

**Roads mode**

| Input | Action |
| --- | --- |
| Click a road | Select it (a side panel shows its details) |
| `+` / `−` | Add / remove a lane |
| `O` | Toggle one-way |
| `R` | Reverse direction |

**Debug:** `F3` stats overlay · `B` geometry view · `V` graph skeleton · `G` grid snap · `Shift+G` grid · `H` help

## Project structure

```
index.html              app shell (toolbar, road panel, help, overlay)
css/style.css
src/
  main.js               wiring: loop → input → camera → editor → road network → render
  engine/               loop.js · camera.js · input.js · debug.js
  math/                 utils.js · matrix.js
  primitives/           point.js · segment.js · polygon.js · envelope.js
  graph/                graph.js · graphEditor.js · storage.js
  road/                 road.js (lane layout) · roadNetwork.js (generation + rendering)
  ui/controls.js        toolbar & road panel bindings
  data/demo.js          sample network
tests/
  unit/                 node:test suites for geometry, graph and road generation
  visual/               interactive geometry test gallery
```

Every module under `math/`, `primitives/`, `graph/graph.js` and `road/` is DOM-free. The unit tests run them directly in Node, and later phases can reuse them in workers.

## Design notes

- **World units vs pixels.** Geometry lives in world units. Editor handles are sized as `pixels / zoom`, so they stay the same size on screen at any zoom level.
- **Rebuild on change, not every frame.** The graph's `version` counter means road geometry is regenerated only when something changes, including while you drag a node. The overlay shows the rebuild time.
- **Bounding-box pre-filtering** keeps polygon union and marking clipping cheap, because only nearby roads are compared.

## Licence

MIT
