import type { Mode, Network, Trip } from "./api";
import { colorKey, type ColorKey } from "./palette";

export interface AnimatedTrip {
  id: number;
  route: number;
  mode: Mode;
  colorKey: ColorKey;
  start: number;
  end: number;
  path: [number, number][];
  /** Times along the path, including the delay. */
  timestamps: number[];
  /** Seconds late according to realtime data; 0 when there is none. */
  delay: number;
}

/**
 * Turns a trip's (distance, time) stop pairs into a path that follows the
 * route shape, with a timestamp for every point. Shape points between two
 * stops get times interpolated by distance, so vehicles move along curves.
 */
export function buildAnimatedTrip(trip: Trip, network: Network): AnimatedTrip | null {
  const shape = network.shapes[trip.shape];
  const route = network.routes[trip.route];
  if (!shape || !route) return null;

  const { coords, dist } = shape;
  const stops = withDwell(trip.stops, DWELL_S[route.mode]);
  const path: [number, number][] = [];
  const timestamps: number[] = [];

  let v = 0; // next shape point to consider
  for (let k = 0; k < stops.length; k += 2) {
    const d = stops[k]!;
    const t = stops[k + 1]!;

    if (k > 0) {
      const prevD = stops[k - 2]!;
      const prevT = stops[k - 1]!;
      while (v < dist.length && dist[v]! < d) {
        if (dist[v]! > prevD) {
          const f = (dist[v]! - prevD) / (d - prevD);
          path.push([coords[v * 2]!, coords[v * 2 + 1]!]);
          timestamps.push(prevT + f * (t - prevT));
        }
        v++;
      }
    } else {
      while (v < dist.length && dist[v]! <= d) v++;
    }

    path.push(pointAtDistance(coords, dist, d));
    timestamps.push(t);
  }

  return {
    id: trip.id,
    route: trip.route,
    mode: route.mode,
    colorKey: colorKey(route),
    start: trip.start,
    end: trip.end,
    path,
    timestamps,
    delay: 0,
  };
}

/** Shifts a trip in time to match its realtime delay. */
export function applyDelay(trip: AnimatedTrip, delay: number): void {
  const shift = delay - trip.delay;
  if (!shift) return;
  for (let i = 0; i < trip.timestamps.length; i++) trip.timestamps[i]! += shift;
  trip.start += shift;
  trip.end += shift;
  trip.delay = delay;
}

/**
 * Seconds a vehicle stands at an intermediate stop. Bus, rail and ferry are
 * measured from SL's GPS positions: the share of vehicles standing still at a
 * stop of their own trip, times the average time between stops (three snapshots,
 * 30 October 2026, evening rush). Metro and tram are not in SL's GPS feed, so
 * theirs are typical values for the network.
 */
const DWELL_S: Record<Mode, number> = { bus: 10, rail: 35, ferry: 50, metro: 25, tram: 20 };

/**
 * Timetables often give one time per stop and no waiting time, so vehicles
 * would roll straight through. This gives every intermediate stop at least the
 * mode's dwell, split around the timetable time, so the trip's total time stays
 * the same. A dwell never takes more than 30% of the travel time on either
 * side, so stops close together still leave time to move. Stops that already
 * wait long enough in the timetable are kept as they are.
 */
function withDwell(stops: number[], dwell: number): number[] {
  // One entry at a distance is a pass-through time; two are arrival and departure.
  const groups: { d: number; arr: number; dep: number }[] = [];
  for (let k = 0; k < stops.length; k += 2) {
    const d = stops[k]!;
    const t = stops[k + 1]!;
    const last = groups[groups.length - 1];
    if (last && last.d === d) last.dep = t;
    else groups.push({ d, arr: t, dep: t });
  }

  const out: number[] = [];
  groups.forEach((g, i) => {
    const missing = dwell - (g.dep - g.arr);
    if (i > 0 && i < groups.length - 1 && missing > 0) {
      g.arr -= Math.min(missing / 2, 0.3 * (g.arr - groups[i - 1]!.dep));
      g.dep += Math.min(missing / 2, 0.3 * (groups[i + 1]!.arr - g.dep));
    }
    out.push(g.d, g.arr);
    if (g.dep !== g.arr) out.push(g.d, g.dep);
  });
  return out;
}

function pointAtDistance(coords: number[], dist: number[], d: number): [number, number] {
  const last = dist.length - 1;
  if (d <= dist[0]!) return [coords[0]!, coords[1]!];
  if (d >= dist[last]!) return [coords[last * 2]!, coords[last * 2 + 1]!];

  const i = upperBound(dist, d); // dist[i - 1] <= d < dist[i]
  const f = (d - dist[i - 1]!) / (dist[i]! - dist[i - 1]! || 1);
  return [
    coords[(i - 1) * 2]! + f * (coords[i * 2]! - coords[(i - 1) * 2]!),
    coords[(i - 1) * 2 + 1]! + f * (coords[i * 2 + 1]! - coords[(i - 1) * 2 + 1]!),
  ];
}

/** Current position of a trip at time t, or null if it isn't running. */
export function positionAt(trip: AnimatedTrip, t: number): [number, number] | null {
  if (t < trip.start || t > trip.end) return null;
  const ts = trip.timestamps;
  const i = Math.max(1, Math.min(ts.length - 1, upperBound(ts, t)));
  const a = trip.path[i - 1]!;
  const b = trip.path[i]!;
  const f = (t - ts[i - 1]!) / (ts[i]! - ts[i - 1]! || 1);
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

/** First index whose value is greater than x. */
function upperBound(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
