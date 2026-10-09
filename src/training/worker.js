// Week 20: training in a Web Worker. The whole training stack is DOM-free, so
// the worker runs the same TrainingSession as the main thread would. It
// streams plain-data snapshots back ~15 times a second; the page only draws.

import { TrainingSession } from './session.js';
import { stepsDue, MAX_SLICE_MS } from './speed.js';

let session = null;
let speed = 1;
let paused = false;
let carry = 0;
let last = 0;
let lastSnapshot = 0;
let timer = null;

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'start':
      try {
        session = new TrainingSession(data.config).start();
      } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
        session = null;
        return;
      }
      carry = 0;
      last = performance.now();
      schedule(0);
      break;
    case 'stop':
      session = null;
      clearTimeout(timer);
      break;
    case 'speed':
      speed = data.speed;
      carry = 0;
      break;
    case 'pause':
      paused = data.paused;
      break;
    case 'next':
      session?.trainer.nextGeneration();
      break;
    case 'skip':
      session?.skipCourse();
      break;
  }
};

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(loop, delay);
}

function loop() {
  if (!session) return;
  const now = performance.now();
  const elapsed = (now - last) / 1000;
  last = now;

  if (!paused) {
    let due;
    ({ due, carry } = stepsDue(speed, elapsed, carry));
    const end = now + MAX_SLICE_MS;
    while (due > 0 && performance.now() < end) {
      const n = Math.min(due, 20);
      session.run(n);
      due -= n;
    }
  }

  const champion = session.takeChampion();
  if (champion) self.postMessage({ type: 'champion', champion });
  if (now - lastSnapshot > 66) {
    lastSnapshot = now;
    const snapshot = session.snapshot();
    self.postMessage({ type: 'snapshot', snapshot }, [snapshot.agents.buffer]);
  }
  schedule(speed === 'max' ? 0 : 8);
}
