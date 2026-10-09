/**
 * requestAnimationFrame game loop with variable delta time.
 *
 * `update(dt)` receives seconds since the previous frame, clamped to
 * `maxDelta` so a backgrounded tab doesn't produce one giant step when it
 * comes back. `timeScale` slows down / speeds up / pauses simulation time
 * while rendering continues.
 */
export class GameLoop {
  constructor({ update, render, maxDelta = 0.1 }) {
    this.update = update;
    this.render = render;
    this.maxDelta = maxDelta;
    this.timeScale = 1;
    this.running = false;
    this.frame = 0;
    this.elapsed = 0;
    this.rawDelta = 0;
    this.lastTime = 0;
    this.rafId = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  tick = (now) => {
    if (!this.running) return;
    this.rawDelta = Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const dt = Math.min(this.rawDelta, this.maxDelta) * this.timeScale;

    this.frame++;
    this.elapsed += dt;
    this.update(dt, this.rawDelta);
    this.render();
    this.rafId = requestAnimationFrame(this.tick);
  };
}
