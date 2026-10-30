// Douglas-Peucker line simplification. Works on flat [lon, lat, lon, lat, ...]
// coordinates and returns the indices (point numbers) to keep.

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos((59.33 * Math.PI) / 180); // Stockholm latitude

export function simplifyIndices(coords: number[], toleranceM: number): number[] {
  const n = coords.length / 2;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(coords, i, first, last);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const result: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) result.push(i);
  return result;
}

/** Distance in meters from point p to the segment a-b. */
function segmentDistance(c: number[], p: number, a: number, b: number): number {
  const px = c[p * 2]! * M_PER_DEG_LON, py = c[p * 2 + 1]! * M_PER_DEG_LAT;
  const ax = c[a * 2]! * M_PER_DEG_LON, ay = c[a * 2 + 1]! * M_PER_DEG_LAT;
  const bx = c[b * 2]! * M_PER_DEG_LON, by = c[b * 2 + 1]! * M_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Haversine-free distance in meters, good enough at city scale. */
export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  return Math.hypot((lon2 - lon1) * M_PER_DEG_LON, (lat2 - lat1) * M_PER_DEG_LAT);
}
