/**
 * Road classes (Week 24). A road's type sets its default speed limit and its
 * look; highways and ramps are grade separated (no at-grade junctions with
 * streets, only merges and exits) and drawn with solid edge lines.
 */
export const ROAD_TYPES = {
  street: { label: 'Street', speedLimit: 50, surface: '#3b4047', edgeLines: false },
  highway: { label: 'Highway', speedLimit: 110, surface: '#32363c', edgeLines: true },
  ramp: { label: 'Ramp', speedLimit: 60, surface: '#32363c', edgeLines: true },
};

/** Default limit in km/h: streets with four or more lanes are avenues (60). */
export function defaultSpeedLimit(type = 'street', lanes = 2) {
  if (type === 'street' && lanes >= 4) return 60;
  return (ROAD_TYPES[type] ?? ROAD_TYPES.street).speedLimit;
}

export function isFreeway(type) {
  return type === 'highway' || type === 'ramp';
}
