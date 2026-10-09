import { clamp } from '../math/utils.js';
import { Matrix } from '../math/matrix.js';
import { Point } from '../primitives/point.js';

/**
 * Maps world coordinates to screen (CSS pixel) coordinates.
 * `center` is the world point shown in the middle of the viewport.
 */
export class Camera {
  constructor({ x = 0, y = 0, zoom = 1, minZoom = 0.05, maxZoom = 10 } = {}) {
    this.center = new Point(x, y);
    this.zoom = zoom;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.viewport = { width: 1, height: 1 };
    this.home = { x, y, zoom };
  }

  setViewport(width, height) {
    this.viewport.width = width;
    this.viewport.height = height;
  }

  /** World → screen transform. */
  get matrix() {
    const { width, height } = this.viewport;
    return Matrix.translation(width / 2, height / 2)
      .scale(this.zoom)
      .translate(-this.center.x, -this.center.y);
  }

  worldToScreen(point) {
    return this.matrix.apply(point);
  }

  screenToWorld(point) {
    return this.matrix.invert().apply(point);
  }

  /** Move by a screen-space delta (e.g. a mouse drag). */
  panScreen(dx, dy) {
    this.center = this.center.subtract(new Point(dx / this.zoom, dy / this.zoom));
  }

  /** Move by a world-space delta. */
  move(dx, dy) {
    this.center = this.center.add(new Point(dx, dy));
  }

  /** Zoom by `factor`, keeping the world point under `screenPoint` fixed. */
  zoomAt(factor, screenPoint) {
    const before = this.screenToWorld(screenPoint);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    const after = this.screenToWorld(screenPoint);
    this.center = this.center.add(before.subtract(after));
  }

  /** Centre and zoom so the given world box fits the viewport. */
  fit(box, padding = 60) {
    if (!Number.isFinite(box.minX)) return this.reset();
    const w = Math.max(1, box.maxX - box.minX);
    const h = Math.max(1, box.maxY - box.minY);
    this.center = new Point((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
    const zx = (this.viewport.width - padding * 2) / w;
    const zy = (this.viewport.height - padding * 2) / h;
    this.zoom = clamp(Math.min(zx, zy), this.minZoom, this.maxZoom);
  }

  reset() {
    this.center = new Point(this.home.x, this.home.y);
    this.zoom = this.home.zoom;
  }

  /** World-space rectangle currently visible. */
  visibleBounds() {
    const tl = this.screenToWorld(new Point(0, 0));
    const br = this.screenToWorld(new Point(this.viewport.width, this.viewport.height));
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
  }

  apply(ctx, pixelRatio = 1) {
    this.matrix.setOn(ctx, pixelRatio);
  }
}
