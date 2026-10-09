/**
 * Maps the keyboard to car input:
 *   ↑ / W       throttle (brakes while reversing)
 *   ↓ / S       brake, then reverse once stopped
 *   ← → / A D   steer
 *   Space       handbrake
 */
export class KeyboardControls {
  constructor(input) {
    this.input = input;
  }

  read() {
    const down = (...codes) => codes.some((c) => this.input.isDown(c));
    const left = down('ArrowLeft', 'KeyA');
    const right = down('ArrowRight', 'KeyD');
    return {
      forward: down('ArrowUp', 'KeyW') ? 1 : 0,
      back: down('ArrowDown', 'KeyS') ? 1 : 0,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: down('Space'),
      allowReverse: true,
    };
  }
}
