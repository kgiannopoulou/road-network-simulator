import { Point } from '../primitives/point.js';

export const MouseButton = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };

/**
 * Polled input state. DOM events only record what happened; game code reads
 * it during `update()` and `endFrame()` clears the per-frame flags. This keeps
 * all logic inside the game loop instead of scattered across event handlers.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keysDown = new Set();
    this.keysPressed = new Set();
    this.keysReleased = new Set();

    this.mouse = {
      position: new Point(0, 0),
      delta: new Point(0, 0),
      buttonsDown: new Set(),
      buttonsPressed: new Set(),
      buttonsReleased: new Set(),
      wheel: 0,
      inside: false,
    };

    this.#bind();
  }

  isDown(code) {
    return this.keysDown.has(code);
  }

  wasPressed(code) {
    return this.keysPressed.has(code);
  }

  wasReleased(code) {
    return this.keysReleased.has(code);
  }

  isMouseDown(button = MouseButton.LEFT) {
    return this.mouse.buttonsDown.has(button);
  }

  wasMousePressed(button = MouseButton.LEFT) {
    return this.mouse.buttonsPressed.has(button);
  }

  wasMouseReleased(button = MouseButton.LEFT) {
    return this.mouse.buttonsReleased.has(button);
  }

  get shift() {
    return this.isDown('ShiftLeft') || this.isDown('ShiftRight');
  }

  get ctrl() {
    return this.isDown('ControlLeft') || this.isDown('ControlRight');
  }

  endFrame() {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mouse.buttonsPressed.clear();
    this.mouse.buttonsReleased.clear();
    this.mouse.delta = new Point(0, 0);
    this.mouse.wheel = 0;
  }

  #bind() {
    const isTyping = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName);
    const gameKeys = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'Tab']);

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (gameKeys.has(e.code)) e.preventDefault();
      if (!this.keysDown.has(e.code)) this.keysPressed.add(e.code);
      this.keysDown.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.code);
      this.keysReleased.add(e.code);
    });

    window.addEventListener('blur', () => {
      this.keysDown.clear();
      this.mouse.buttonsDown.clear();
    });

    const updatePosition = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const next = new Point(e.clientX - rect.left, e.clientY - rect.top);
      this.mouse.delta = this.mouse.delta.add(next.subtract(this.mouse.position));
      this.mouse.position = next;
    };

    this.canvas.addEventListener('mousedown', (e) => {
      updatePosition(e);
      this.mouse.buttonsDown.add(e.button);
      this.mouse.buttonsPressed.add(e.button);
      if (e.button === MouseButton.MIDDLE) e.preventDefault();
    });

    window.addEventListener('mousemove', updatePosition);

    window.addEventListener('mouseup', (e) => {
      updatePosition(e);
      if (this.mouse.buttonsDown.delete(e.button)) this.mouse.buttonsReleased.add(e.button);
    });

    this.canvas.addEventListener('mouseenter', () => (this.mouse.inside = true));
    this.canvas.addEventListener('mouseleave', () => (this.mouse.inside = false));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        updatePosition(e);
        // Normalise line/page deltas to pixels.
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        this.mouse.wheel += e.deltaY * scale;
      },
      { passive: false },
    );
  }
}
