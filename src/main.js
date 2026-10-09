import { KeyboardControls } from './car/keyboardControls.js';
import { NO_INPUT } from './car/physics.js';
import { toKmh } from './car/units.js';
import { Camera } from './engine/camera.js';
import { DebugOverlay, drawGrid, FpsCounter } from './engine/debug.js';
import { Input, MouseButton } from './engine/input.js';
import { GameLoop } from './engine/loop.js';
import { createDemoGraph } from './data/demo.js';
import { EditorMode, GraphEditor } from './graph/graphEditor.js';
import { downloadGraph, loadGraph, readGraphFile, saveGraph } from './graph/storage.js';
import { RoadNetwork } from './road/roadNetwork.js';
import { Simulation } from './sim/simulation.js';
import { Controls } from './ui/controls.js';
import { Hud } from './ui/hud.js';
import { SensorPanel } from './ui/sensorPanel.js';
import { TrainingPanel } from './ui/trainingPanel.js';
import { Brain } from './ai/brain.js';

const PAN_SPEED = 700; // screen pixels per second
const ZOOM_SENSITIVITY = 0.0015;
const AUTOSAVE_DELAY = 0.5; // seconds after the last change
const FOLLOW_STIFFNESS = 6; // camera catch-up rate in drive mode (1/s)

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const input = new Input(canvas);
const camera = new Camera();
const graph = loadGraph() ?? createDemoGraph();
const network = new RoadNetwork(graph);
const editor = new GraphEditor(graph, { camera, input, laneWidth: network.options.laneWidth });
const sim = new Simulation(network, { trafficCount: 12 });
const keyboard = new KeyboardControls(input);
const fps = new FpsCounter();
const overlay = new DebugOverlay(document.getElementById('debug'));
const hud = new Hud(document.getElementById('car-panel'));
const sensorPanel = new SensorPanel(document.getElementById('sensor-panel'), sim.sensors);
const PRESET_CYCLE = ['perfect', 'realistic', 'degraded'];
const trainingPanel = new TrainingPanel(document.getElementById('training-panel'), sim, { onAutopilot: () => toggleAutopilot() });

const view = { showGrid: true, showGraph: true, debugGeometry: false, collisionDebug: false, trafficDebug: false };
let pixelRatio = 1;
let panning = false;
let savedVersion = graph.version;
let saveTimer = 0;

const flag = (get, set) => ({ get, set });
const controls = new Controls({
  editor,
  network,
  flags: {
    snapToGrid: flag(() => editor.snapToGrid, (v) => (editor.snapToGrid = v)),
    showGrid: flag(() => view.showGrid, (v) => (view.showGrid = v)),
    showGraph: flag(() => view.showGraph, (v) => (view.showGraph = v)),
    debugGeometry: flag(() => view.debugGeometry, (v) => (view.debugGeometry = v)),
    showOverlay: flag(() => overlay.visible, () => overlay.toggle()),
    traffic: flag(() => sim.trafficEnabled, (v) => sim.setTrafficEnabled(v)),
    collisionDebug: flag(() => view.collisionDebug, (v) => (view.collisionDebug = v)),
    trafficDebug: flag(() => view.trafficDebug, (v) => (view.trafficDebug = v)),
    ghost: flag(() => sim.ghost, (v) => (sim.ghost = v)),
    paused: flag(() => sim.paused, (v) => (sim.paused = v)),
    showSensors: flag(() => sensorPanel.visible, (v) => sensorPanel.toggle(v)),
  },
  actions: {
    fit: () => camera.fit(graph.boundingBox()),
    demo: () => replaceGraph(createDemoGraph()),
    clear: () => graph.clear(),
    export: () => downloadGraph(graph),
    import: async (file) => {
      try {
        replaceGraph(await readGraphFile(file));
      } catch (err) {
        console.error('Could not import graph:', err);
      }
    },
    model: () => sim.toggleModel(),
    weather: () => sim.cycleWeather(),
    resetCar: () => sim.resetPlayer(),
    autopilot: () => toggleAutopilot(),
  },
});

function replaceGraph(next) {
  graph.load(next);
  editor.setMode(editor.mode);
  camera.fit(graph.boundingBox());
}

function resize() {
  pixelRatio = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = canvas;
  canvas.width = Math.round(w * pixelRatio);
  canvas.height = Math.round(h * pixelRatio);
  camera.setViewport(w, h);
  // Panels sit below the toolbar, which wraps onto more rows on narrow screens.
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--panel-top', `${Math.round(toolbarBottom + 10)}px`);
}

const driving = () => editor.mode === EditorMode.DRIVE;
const training = () => editor.mode === EditorMode.TRAIN;

/**
 * Autopilot: the champion (or, with none trained yet, a random and
 * therefore terrible brain) drives the player's car from its ray sensor.
 */
function toggleAutopilot() {
  if (sim.autopilot) {
    sim.disableAutopilot();
    return;
  }
  const champion = trainingPanel.champion;
  sim.enableAutopilot(champion ? Brain.fromJSON(champion.brain) : new Brain());
  sensorPanel.syncConfig();
  editor.setMode(EditorMode.DRIVE);
}

// ---- update ---------------------------------------------------------------

function handleShortcuts() {
  const k = (code) => input.wasPressed(code);
  if (k('Digit1')) editor.setMode(EditorMode.GRAPH);
  if (k('Digit2')) editor.setMode(EditorMode.ROAD);
  if (k('Digit3')) editor.setMode(EditorMode.DRIVE);
  if (k('Digit4')) editor.setMode(EditorMode.TRAIN);
  if (k('KeyK')) toggleAutopilot();
  if (k('KeyG')) {
    if (input.shift) view.showGrid = !view.showGrid;
    else editor.snapToGrid = !editor.snapToGrid;
  }
  if (k('KeyV')) view.showGraph = !view.showGraph;
  if (k('KeyB')) view.debugGeometry = !view.debugGeometry;
  if (k('F3')) overlay.toggle();
  if (k('KeyH')) controls.toggleHelp();
  if (k('KeyF')) camera.fit(graph.boundingBox());
  if (k('Digit0')) camera.reset();

  // Simulation.
  if (k('KeyT')) sim.setTrafficEnabled(!sim.trafficEnabled);
  if (k('BracketLeft')) sim.setTrafficCount(sim.savedTrafficCount - 2);
  if (k('BracketRight')) sim.setTrafficCount(sim.savedTrafficCount + 2);
  if (k('KeyM')) sim.toggleModel();
  if (k('KeyY')) sim.cycleWeather();
  if (k('KeyC')) view.collisionDebug = !view.collisionDebug;
  if (k('KeyX')) view.trafficDebug = !view.trafficDebug;
  if (k('KeyN')) sim.ghost = !sim.ghost;
  if (k('KeyP')) sim.paused = !sim.paused;
  if (driving() && k('KeyR')) sim.resetPlayer();
  if (k('KeyI')) sensorPanel.toggle();
  if (k('KeyU')) {
    const next = PRESET_CYCLE[(PRESET_CYCLE.indexOf(sim.sensors.preset) + 1) % PRESET_CYCLE.length];
    sensorPanel.setPreset(next);
  }
}

function updateCamera(dt, rawDelta) {
  const spaceHeld = !driving() && input.isDown('Space');

  if (driving() || training()) {
    // Follow the car (or the training leader), looking a little ahead of it.
    // Uses real time so the camera still moves while the simulation is paused.
    const car = (training() && sim.trainer?.leader?.car) || sim.player;
    const target = car.position.add(car.velocity.scale(0.35));
    const t = 1 - Math.exp(-FOLLOW_STIFFNESS * rawDelta);
    camera.center = camera.center.add(target.subtract(camera.center).scale(t));
  } else {
    // Keyboard movement, scaled by delta time so speed is frame-rate independent.
    let dx = 0;
    let dy = 0;
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) dy -= 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) dy += 1;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) dx -= 1;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const speed = (PAN_SPEED * rawDelta) / camera.zoom / len;
      camera.move(dx * speed, dy * speed);
    }
  }

  // Mouse drag panning: middle button, or Space + left button.
  panning =
    !driving() &&
    !training() &&
    (input.isMouseDown(MouseButton.MIDDLE) || (spaceHeld && input.isMouseDown(MouseButton.LEFT)));
  if (panning) camera.panScreen(input.mouse.delta.x, input.mouse.delta.y);

  if (input.mouse.wheel) {
    const anchor = driving() || training()
      ? { x: camera.viewport.width / 2, y: camera.viewport.height / 2 }
      : input.mouse.position;
    camera.zoomAt(Math.exp(-input.mouse.wheel * ZOOM_SENSITIVITY), anchor);
  }

  canvas.style.cursor = driving() || training()
    ? 'default'
    : panning
      ? 'grabbing'
      : spaceHeld
        ? 'grab'
        : editor.dragging
          ? 'move'
          : editor.hovered || editor.hoveredSegment
            ? 'pointer'
            : 'crosshair';
  return spaceHeld;
}

function autosave(rawDelta) {
  if (graph.version === savedVersion) return;
  saveTimer += rawDelta;
  if (saveTimer < AUTOSAVE_DELAY || editor.dragging) return;
  saveGraph(graph);
  savedVersion = graph.version;
  saveTimer = 0;
}

function update(dt, rawDelta) {
  fps.tick(rawDelta);
  handleShortcuts();
  const spaceHeld = updateCamera(dt, rawDelta);
  editor.update(panning || spaceHeld);
  network.update();
  // Re-plan traffic once a graph edit is finished (not on every drag frame).
  if (sim.needsSync() && !editor.dragging) sim.syncRoads();
  if (training() && sim.trainer) {
    // Fast-forward: several simulation steps per rendered frame.
    for (let i = 0; i < trainingPanel.speed; i++) {
      sim.update(dt, NO_INPUT);
      sim.updateTraining(dt);
    }
  } else {
    const input = driving() ? (sim.autopilot ? sim.autopilotInput() : keyboard.read()) : NO_INPUT;
    sim.update(dt, input);
  }
  autosave(rawDelta);
  controls.sync();
  hud.update(sim, rawDelta, driving());
  sensorPanel.update(rawDelta);
  trainingPanel.show(training());
  trainingPanel.update(rawDelta);
  document.body.classList.toggle('driving', driving());
  document.body.classList.toggle('training', training());

  const mouseWorld = editor.mouse;
  const stats = network.stats();
  const car = sim.player.state;
  overlay.set('FPS', `${fps.fps.toFixed(0)}  (${fps.frameMs.toFixed(1)} ms, worst ${fps.worstMs.toFixed(1)} ms)`);
  overlay.set('Frame', `${loop.frame}  dt ${(dt * 1000).toFixed(1)} ms`);
  overlay.set('Camera', `${camera.center.x.toFixed(0)}, ${camera.center.y.toFixed(0)}  zoom ${camera.zoom.toFixed(2)}`);
  overlay.set('Mouse', `${mouseWorld.x.toFixed(0)}, ${mouseWorld.y.toFixed(0)}`);
  overlay.set('Graph', `${graph.points.length} nodes, ${graph.segments.length} edges (v${graph.version})`);
  overlay.set('Roads', `${stats.roads} roads, ${stats.borders} border segs`);
  overlay.set('Markings', `${stats.markings} lines, ${stats.arrows} arrows`);
  overlay.set('Rebuild', `${network.buildMs.toFixed(2)} ms`);
  overlay.set('Car', `${car.x.toFixed(0)}, ${car.y.toFixed(0)}  ${toKmh(car.speed).toFixed(0)} km/h`);
  overlay.set('Traffic', `${sim.traffic.cars.length} vehicles`);
  overlay.set('Sensors', `${sim.sensors.preset} · ${sim.sensors.sensors.filter((s) => s.status === 'ok').length}/${sim.sensors.sensors.length} ok`);
  if (sim.trainer) overlay.set('Training', `gen ${sim.trainer.generation} · ${sim.trainer.alive.length}/${sim.trainer.agents.length} alive · champion ${(sim.trainer.champion?.fitness ?? 0).toFixed(0)} m`);
  overlay.set('Sim', `${sim.stepMs.toFixed(2)} ms, ${sim.substeps} substep${sim.substeps > 1 ? 's' : ''}${sim.paused ? ' (paused)' : ''}`);
  overlay.update(rawDelta);

  input.endFrame();
}

// ---- render -----------------------------------------------------------------

function render() {
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = '#1d2a22';
  ctx.fillRect(0, 0, camera.viewport.width, camera.viewport.height);

  camera.apply(ctx, pixelRatio);
  if (view.showGrid) drawGrid(ctx, camera);
  network.draw(ctx, { debug: view.debugGeometry });
  sim.draw(ctx, {
    collisionDebug: view.collisionDebug,
    trafficDebug: view.trafficDebug,
    showSensors: sensorPanel.visible,
    training: training(),
    pixel: 1 / camera.zoom,
  });
  editor.draw(ctx, { showGraph: view.showGraph });
}

const loop = new GameLoop({ update, render });

window.addEventListener('resize', resize);
resize();
network.update();
sim.syncRoads();
camera.fit(graph.boundingBox());
camera.home = { x: camera.center.x, y: camera.center.y, zoom: camera.zoom };
loop.start();

// Handy for poking at things from the browser console.
window.sim = { graph, network, editor, camera, input, loop, sim };
