import { Camera } from './engine/camera.js';
import { DebugOverlay, drawGrid, FpsCounter } from './engine/debug.js';
import { Input, MouseButton } from './engine/input.js';
import { GameLoop } from './engine/loop.js';
import { createDemoGraph } from './data/demo.js';
import { EditorMode, GraphEditor } from './graph/graphEditor.js';
import { downloadGraph, loadGraph, readGraphFile, saveGraph } from './graph/storage.js';
import { RoadNetwork } from './road/roadNetwork.js';
import { Controls } from './ui/controls.js';

const PAN_SPEED = 700; // screen pixels per second
const ZOOM_SENSITIVITY = 0.0015;
const AUTOSAVE_DELAY = 0.5; // seconds after the last change

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const input = new Input(canvas);
const camera = new Camera();
const graph = loadGraph() ?? createDemoGraph();
const network = new RoadNetwork(graph);
const editor = new GraphEditor(graph, { camera, input, laneWidth: network.options.laneWidth });
const fps = new FpsCounter();
const overlay = new DebugOverlay(document.getElementById('debug'));

const view = { showGrid: true, showGraph: true, debugGeometry: false };
let pixelRatio = 1;
let panning = false;
let savedVersion = graph.version;
let saveTimer = 0;

const controls = new Controls({
  editor,
  network,
  flags: {
    snapToGrid: { get: () => editor.snapToGrid, set: (v) => (editor.snapToGrid = v) },
    showGrid: { get: () => view.showGrid, set: (v) => (view.showGrid = v) },
    showGraph: { get: () => view.showGraph, set: (v) => (view.showGraph = v) },
    debugGeometry: { get: () => view.debugGeometry, set: (v) => (view.debugGeometry = v) },
    showOverlay: { get: () => overlay.visible, set: () => overlay.toggle() },
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
}

// ---- update ---------------------------------------------------------------

function handleShortcuts() {
  const k = (code) => input.wasPressed(code);
  if (k('Digit1')) editor.setMode(EditorMode.GRAPH);
  if (k('Digit2')) editor.setMode(EditorMode.ROAD);
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
}

function updateCamera(dt) {
  // Keyboard movement, scaled by delta time so speed is frame-rate independent.
  let dx = 0;
  let dy = 0;
  if (input.isDown('KeyW') || input.isDown('ArrowUp')) dy -= 1;
  if (input.isDown('KeyS') || input.isDown('ArrowDown')) dy += 1;
  if (input.isDown('KeyA') || input.isDown('ArrowLeft')) dx -= 1;
  if (input.isDown('KeyD') || input.isDown('ArrowRight')) dx += 1;
  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    const speed = (PAN_SPEED * dt) / camera.zoom / len;
    camera.move(dx * speed, dy * speed);
  }

  // Mouse drag panning: middle button, or Space + left button.
  const spaceHeld = input.isDown('Space');
  panning =
    input.isMouseDown(MouseButton.MIDDLE) || (spaceHeld && input.isMouseDown(MouseButton.LEFT));
  if (panning) camera.panScreen(input.mouse.delta.x, input.mouse.delta.y);

  if (input.mouse.wheel) {
    camera.zoomAt(Math.exp(-input.mouse.wheel * ZOOM_SENSITIVITY), input.mouse.position);
  }

  canvas.style.cursor = panning
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
  const spaceHeld = updateCamera(dt);
  editor.update(panning || spaceHeld);
  network.update();
  autosave(rawDelta);
  controls.sync();

  const mouseWorld = editor.mouse;
  const stats = network.stats();
  overlay.set('FPS', `${fps.fps.toFixed(0)}  (${fps.frameMs.toFixed(1)} ms, worst ${fps.worstMs.toFixed(1)} ms)`);
  overlay.set('Frame', `${loop.frame}  dt ${(dt * 1000).toFixed(1)} ms`);
  overlay.set('Camera', `${camera.center.x.toFixed(0)}, ${camera.center.y.toFixed(0)}  zoom ${camera.zoom.toFixed(2)}`);
  overlay.set('Mouse', `${mouseWorld.x.toFixed(0)}, ${mouseWorld.y.toFixed(0)}`);
  overlay.set('Graph', `${graph.points.length} nodes, ${graph.segments.length} edges (v${graph.version})`);
  overlay.set('Roads', `${stats.roads} roads, ${stats.borders} border segs`);
  overlay.set('Markings', `${stats.markings} lines, ${stats.arrows} arrows`);
  overlay.set('Rebuild', `${network.buildMs.toFixed(2)} ms`);
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
  editor.draw(ctx, { showGraph: view.showGraph });
}

const loop = new GameLoop({ update, render });

window.addEventListener('resize', resize);
resize();
camera.fit(graph.boundingBox());
camera.home = { x: camera.center.x, y: camera.center.y, zoom: camera.zoom };
loop.start();

// Handy for poking at things from the browser console.
window.sim = { graph, network, editor, camera, input, loop };
