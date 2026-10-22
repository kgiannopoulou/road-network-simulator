# Contributing

Thanks for taking a look. This is a personal portfolio project, but issues and
pull requests are welcome.

## Setup

Node.js 22+. There are no dependencies to install and no build step.

```bash
git clone https://github.com/kgiannopoulou/road-network-simulator.git
cd road-network-simulator
npm start        # http://localhost:8080
npm test         # 180 unit tests with node:test
npm run bench    # A* vs Dijkstra
```

## Ground rules

* **Zero runtime dependencies.** Everything — physics, geometry, the neural
  network, path-finding — is written by hand on purpose. Please don't add libraries.
* **Headless first.** Simulation code must run in Node without a canvas; the
  renderer only draws state. That's what lets the tests drive the same code
  the browser runs.
* **Deterministic.** Randomness is injected (`rng` options, defaulting to
  `Math.random` for casual use); tests and training pass the seeded RNG from
  `src/math/random.js` so runs are reproducible. Keep new code injectable the same way.
* **Tests with every change.** New behaviour gets a unit test; bugs get a
  regression test. If you change training, re-run the committed configs and
  update their metrics.

## Workflow

* Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
* Conventional Commits: `feat: add roundabouts`, `fix: stop cars entering a blocked junction`.
* Open a pull request with what changed, why, and how you tested it; CI runs the
  tests, the benchmark and a reproducible training smoke run.
