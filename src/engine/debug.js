/** Frames-per-second counter averaged over a short sampling window. */
export class FpsCounter {
  #worstInWindow = 0;

  constructor(window = 0.5) {
    this.window = window;
    this.frames = 0;
    this.time = 0;
    this.fps = 0;
    this.frameMs = 0;
    this.worstMs = 0;
  }

  tick(rawDelta) {
    this.frames++;
    this.time += rawDelta;
    this.#worstInWindow = Math.max(this.#worstInWindow, rawDelta * 1000);
    if (this.time >= this.window) {
      this.fps = this.frames / this.time;
      this.frameMs = (this.time / this.frames) * 1000;
      this.worstMs = this.#worstInWindow;
      this.frames = 0;
      this.time = 0;
      this.#worstInWindow = 0;
    }
  }
}

/**
 * Text overlay for live debug values. Values are collected every frame with
 * `set()` but the DOM is only touched a few times per second.
 */
export class DebugOverlay {
  constructor(element, { refreshRate = 10 } = {}) {
    this.element = element;
    this.values = new Map();
    this.visible = true;
    this.interval = 1 / refreshRate;
    this.timer = 0;
  }

  set(label, value) {
    this.values.set(label, value);
  }

  toggle() {
    this.visible = !this.visible;
    this.element.hidden = !this.visible;
  }

  update(rawDelta) {
    if (!this.visible) return;
    this.timer += rawDelta;
    if (this.timer < this.interval) return;
    this.timer = 0;
    const width = Math.max(...[...this.values.keys()].map((k) => k.length));
    this.element.textContent = [...this.values]
      .map(([k, v]) => `${k.padEnd(width)}  ${v}`)
      .join('\n');
  }
}

/**
 * Infinite world grid. The spacing adapts to the zoom level so lines never get
 * denser than `minPixelSpacing` on screen; every fifth line is emphasised.
 */
export function drawGrid(ctx, camera, { baseSpacing = 50, minPixelSpacing = 14 } = {}) {
  let spacing = baseSpacing;
  while (spacing * camera.zoom < minPixelSpacing) spacing *= 5;
  while (spacing * camera.zoom > minPixelSpacing * 25) spacing /= 5;

  const b = camera.visibleBounds();
  const px = 1 / camera.zoom; // one screen pixel in world units

  const startX = Math.floor(b.minX / spacing) * spacing;
  const startY = Math.floor(b.minY / spacing) * spacing;

  ctx.lineWidth = px;
  for (const major of [false, true]) {
    ctx.beginPath();
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)';
    for (let x = startX; x <= b.maxX; x += spacing) {
      if (isMajor(x, spacing) !== major) continue;
      ctx.moveTo(x, b.minY);
      ctx.lineTo(x, b.maxY);
    }
    for (let y = startY; y <= b.maxY; y += spacing) {
      if (isMajor(y, spacing) !== major) continue;
      ctx.moveTo(b.minX, y);
      ctx.lineTo(b.maxX, y);
    }
    ctx.stroke();
  }

  // World axes.
  ctx.lineWidth = px * 1.5;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 99, 99, 0.45)';
  ctx.moveTo(b.minX, 0);
  ctx.lineTo(b.maxX, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(99, 255, 140, 0.45)';
  ctx.moveTo(0, b.minY);
  ctx.lineTo(0, b.maxY);
  ctx.stroke();

  return spacing;
}

function isMajor(value, spacing) {
  return Math.abs(Math.round(value / spacing) % 5) === 0;
}
