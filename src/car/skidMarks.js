import { m } from './units.js';

/**
 * Tyre marks left by sliding or hard-braking cars. Stored as a fixed-size
 * ring of line segments so long sessions don't grow memory.
 */
export class SkidMarks {
  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.marks = [];
    this.next = 0;
    this.last = new Map(); // car id → previous rear wheel positions
  }

  record(car) {
    const s = car.state;
    const hardBraking = s.braking && s.accel < -m(6) && Math.abs(s.speed) > m(4);
    const marking = (s.sliding && Math.abs(s.speed) > m(2)) || hardBraking;
    if (!marking) {
      this.last.delete(car.id);
      return;
    }
    const wheels = car.rearWheels();
    const prev = this.last.get(car.id);
    if (prev) {
      for (let i = 0; i < wheels.length; i++) this.#push([prev[i], wheels[i]]);
    }
    this.last.set(car.id, wheels);
  }

  #push(mark) {
    if (this.marks.length < this.capacity) this.marks.push(mark);
    else this.marks[this.next] = mark;
    this.next = (this.next + 1) % this.capacity;
  }

  clear() {
    this.marks = [];
    this.next = 0;
    this.last.clear();
  }

  draw(ctx) {
    if (this.marks.length === 0) return;
    ctx.beginPath();
    for (const [a, b] of this.marks) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.strokeStyle = 'rgba(12, 12, 12, 0.45)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}
