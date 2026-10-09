/**
 * Uniform grid broad phase. Items are stored in every cell their bounding box
 * touches; a query returns each item near a box once.
 */
export class SpatialHash {
  constructor(cellSize = 80) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.count = 0;
  }

  clear() {
    this.cells.clear();
    this.count = 0;
  }

  insert(item, box) {
    this.#forCells(box, (key) => {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = []));
      cell.push(item);
    });
    this.count++;
  }

  query(box) {
    const found = new Set();
    this.#forCells(box, (key) => {
      const cell = this.cells.get(key);
      if (cell) for (const item of cell) found.add(item);
    });
    return [...found];
  }

  /** Bounds of the cells a box covers (for debug drawing). */
  cellBounds(box) {
    const s = this.cellSize;
    const result = [];
    this.#forCells(box, (key, cx, cy) => {
      if (this.cells.has(key)) result.push({ minX: cx * s, minY: cy * s, maxX: (cx + 1) * s, maxY: (cy + 1) * s });
    });
    return result;
  }

  #forCells(box, fn) {
    const s = this.cellSize;
    const x0 = Math.floor(box.minX / s);
    const x1 = Math.floor(box.maxX / s);
    const y0 = Math.floor(box.minY / s);
    const y1 = Math.floor(box.maxY / s);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) fn(`${cx},${cy}`, cx, cy);
    }
  }
}
