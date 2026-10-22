# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- README: limitations section.
- `CONTRIBUTING.md` and this changelog.

## [1.1.0] - 2026-10-17

### Added
- Edge-case tests (disconnected maps, unreachable destinations, degenerate geometry, A* = Dijkstra on random networks).
- A* vs Dijkstra benchmark (`npm run bench`) and reproducible headless training from JSON configs.
- Rewritten README with results, live demo and documentation index.

## [1.0.0] - 2026-10-09

### Added
- Phase 1: canvas engine, geometry library, road graph editor and procedural roads.
- Phase 2: car physics, collision system and traffic vehicles.
- Phase 3: ray sensors, LiDAR, radar, GPS and IMU with imperfections.
- Phase 4: neural network, genetic algorithm and population training.
- Phase 5: fitness function, curriculum, training dashboard and fast simulation.
- Phase 6: city simulation with junctions, signals, signs, lanes and highways.
- Phase 7: navigation with A*/Dijkstra routing and an autonomous-driving stack.

[Unreleased]: https://github.com/kgiannopoulou/road-network-simulator/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kgiannopoulou/road-network-simulator/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kgiannopoulou/road-network-simulator/releases/tag/v1.0.0
