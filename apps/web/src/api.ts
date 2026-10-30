// Types mirror apps/server/src/schedule/network.ts.

export type Mode = "bus" | "metro" | "tram" | "rail" | "ferry";

export interface Route {
  name: string;
  mode: Mode;
  desc: string;
}

export interface Shape {
  route: number;
  coords: number[];
  dist: number[];
}

export interface Trip {
  id: number;
  route: number;
  shape: number;
  start: number;
  end: number;
  stops: number[];
}

export interface Station {
  name: string;
  lon: number;
  lat: number;
  /** One bit per mode that stops here today (see MODE_BITS). */
  modes: number;
}

export const MODE_BITS: Record<Mode, number> = { bus: 1, metro: 2, tram: 4, rail: 8, ferry: 16 };

export interface Network {
  serviceDate: string;
  routes: Route[];
  shapes: Shape[];
  /** Index = station id. */
  stations: Station[];
  stats: DailyStats;
  /** Trips on the road per 10-minute slot of the day (144 values). */
  activity: number[];
}

export async function fetchNetwork(): Promise<Network> {
  // Always revalidate: a copy cached before a server rebuild would not match the trips.
  const res = await fetch("/api/network", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load network: HTTP ${res.status}`);
  return res.json();
}

/** Trips are tied to the service date they were built for; ids differ between days. */
export async function fetchTrips(
  from: number,
  to: number,
): Promise<{ serviceDate: string; trips: Trip[] }> {
  const res = await fetch(`/api/trips?from=${Math.floor(from)}&to=${Math.ceil(to)}`);
  if (!res.ok) throw new Error(`Failed to load trips: HTTP ${res.status}`);
  return res.json();
}

export interface TripDetails {
  serviceDate: string;
  id: number;
  route: Route;
  headsign: string;
  /** Scheduled stops in order; times are seconds since midnight of the service date. */
  calls: { name: string; arrival: number; departure: number }[];
}

export async function fetchTripDetails(id: number): Promise<TripDetails> {
  const res = await fetch(`/api/trip?id=${id}`);
  if (!res.ok) throw new Error(`Failed to load trip ${id}: HTTP ${res.status}`);
  return res.json();
}

export interface StationDetails extends Station {
  serviceDate: string;
  id: number;
  /** Vehicles stopping here during today's calendar day. */
  total: number;
  /** Vehicles per hour, 24 values. */
  hourly: number[];
  /** [route, vehicles today], busiest first. */
  lines: [number, number][];
  headsigns: string[];
  /** Flat [time, trip, route, headsign, ...] sorted by time; headsign indexes `headsigns`. */
  departures: number[];
}

/** Facts about today's timetable (see apps/server/src/schedule/stats.ts). */
export interface DailyStats {
  trips: number;
  distanceKm: number;
  peak: { time: number; vehicles: number };
  busiestStation: { name: string; vehicles: number };
  busiestLine: { route: number; trips: number };
  longestTrip: { route: number; headsign: string; from: string; minutes: number };
}

export interface Delays {
  serviceDate: string;
  /** When SL generated the data (Unix seconds); null when realtime is off on the server. */
  updatedAt: number | null;
  /** Flat [trip, seconds late, ...]; negative means early. */
  delays: number[];
  canceled: number[];
  /** Share of trips within 3 minutes of the timetable; null without realtime. */
  onTimeShare: number | null;
  /** The trip running latest right now. */
  latest: { route: number; headsign: string; delay: number } | null;
}

export interface Alert {
  /** GTFS-RT cause, e.g. "TECHNICAL_PROBLEM". */
  cause: string;
  header: string;
  description: string;
  start: number | null;
  end: number | null;
  /** Incidents and short disruptions; long planned changes are not acute. */
  acute: boolean;
  routes: number[];
  stations: number[];
  trips: number[];
}

export async function fetchAlerts(): Promise<{ serviceDate: string; alerts: Alert[] }> {
  const res = await fetch("/api/alerts");
  if (!res.ok) throw new Error(`Failed to load alerts: HTTP ${res.status}`);
  return res.json();
}

export async function fetchDelays(): Promise<Delays> {
  const res = await fetch("/api/delays");
  if (!res.ok) throw new Error(`Failed to load delays: HTTP ${res.status}`);
  return res.json();
}

export async function fetchStation(id: number): Promise<StationDetails> {
  const res = await fetch(`/api/station?id=${id}`);
  if (!res.ok) throw new Error(`Failed to load station ${id}: HTTP ${res.status}`);
  return res.json();
}
