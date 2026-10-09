/**
 * Polynomials for trajectory generation (Week 28).
 *
 * Quintic: position from (x0, v0, a0) to (xT, vT, aT) in time T, the
 * minimum-jerk curve used for lateral moves and for stopping at a point.
 * Quartic: from (x0, v0, a0) to a speed vT with acceleration aT, used for
 * "reach this speed" (velocity keeping), where the end position is free.
 */
export class Quintic {
  constructor(x0, v0, a0, xT, vT, aT, T) {
    this.T = T;
    const c0 = x0;
    const c1 = v0;
    const c2 = a0 / 2;
    const T2 = T * T;
    const T3 = T2 * T;
    const T4 = T3 * T;
    const T5 = T4 * T;
    const b0 = xT - (c0 + c1 * T + c2 * T2);
    const b1 = vT - (c1 + 2 * c2 * T);
    const b2 = aT - 2 * c2;
    // Solve [[T3,T4,T5],[3T2,4T3,5T4],[6T,12T2,20T3]] · [c3,c4,c5] = [b0,b1,b2].
    const c3 = (10 * b0) / T3 - (4 * b1) / T2 + b2 / (2 * T);
    const c4 = (-15 * b0) / T4 + (7 * b1) / T3 - b2 / T2;
    const c5 = (6 * b0) / T5 - (3 * b1) / T4 + b2 / (2 * T3);
    this.c = [c0, c1, c2, c3, c4, c5];
  }

  /** Value, first, second and third derivative at time t (held constant after T). */
  at(t) {
    const [c0, c1, c2, c3, c4, c5] = this.c;
    if (t > this.T) {
      const end = this.at(this.T);
      return { x: end.x + end.v * (t - this.T), v: end.v, a: 0, j: 0 };
    }
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    const t5 = t4 * t;
    return {
      x: c0 + c1 * t + c2 * t2 + c3 * t3 + c4 * t4 + c5 * t5,
      v: c1 + 2 * c2 * t + 3 * c3 * t2 + 4 * c4 * t3 + 5 * c5 * t4,
      a: 2 * c2 + 6 * c3 * t + 12 * c4 * t2 + 20 * c5 * t3,
      j: 6 * c3 + 24 * c4 * t + 60 * c5 * t2,
    };
  }
}

export class Quartic {
  constructor(x0, v0, a0, vT, aT, T) {
    this.T = T;
    const c0 = x0;
    const c1 = v0;
    const c2 = a0 / 2;
    const T2 = T * T;
    const b1 = vT - (c1 + 2 * c2 * T);
    const b2 = aT - 2 * c2;
    // Solve [[3T2,4T3],[6T,12T2]] · [c3,c4] = [b1,b2].
    const c3 = b1 / T2 - b2 / (3 * T);
    const c4 = -b1 / (2 * T2 * T) + b2 / (4 * T2);
    this.c = [c0, c1, c2, c3, c4];
  }

  at(t) {
    const [c0, c1, c2, c3, c4] = this.c;
    if (t > this.T) {
      const end = this.at(this.T);
      return { x: end.x + end.v * (t - this.T), v: end.v, a: 0, j: 0 };
    }
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    return {
      x: c0 + c1 * t + c2 * t2 + c3 * t3 + c4 * t4,
      v: c1 + 2 * c2 * t + 3 * c3 * t2 + 4 * c4 * t3,
      a: 2 * c2 + 6 * c3 * t + 12 * c4 * t2,
      j: 6 * c3 + 24 * c4 * t,
    };
  }
}
