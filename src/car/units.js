// World units ↔ metric. A 22-unit lane is 3.3 m wide, so 1 m ≈ 6.67 units.
// Physics parameters are written in metres / seconds and converted once.

export const UNITS_PER_METER = 22 / 3.3;

export function m(meters) {
  return meters * UNITS_PER_METER;
}

export function toMeters(units) {
  return units / UNITS_PER_METER;
}

export function fromKmh(kmh) {
  return (kmh / 3.6) * UNITS_PER_METER;
}

export function toKmh(unitsPerSecond) {
  return (unitsPerSecond / UNITS_PER_METER) * 3.6;
}

export const GRAVITY = m(9.81);
