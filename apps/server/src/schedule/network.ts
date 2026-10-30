// Builds today's scheduled network from static GTFS: routes, simplified route
// shapes, stations, and every trip that runs today as (distance along shape,
// time) pairs. The web client turns these into animated paths.
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { readCsv } from "../gtfs/csv.js";
import { activeServiceIds, parseGtfsTime, previousServiceDate } from "../gtfs/service.js";
import { distanceM, simplifyIndices } from "./simplify.js";

export type Mode = "bus" | "metro" | "tram" | "rail" | "ferry";

export interface Route {
  name: string;
  mode: Mode;
  /** e.g. "tunnelbanans gröna linje", "Roslagsbanan". Used for line colors. */
  desc: string;
}

export interface Shape {
  route: number;
  /** Flat [lon, lat, lon, lat, ...], simplified. */
  coords: number[];
  /** Distance along the original shape in meters, one per point. */
  dist: number[];
}

export interface Trip {
  route: number;
  shape: number;
  /** Seconds since midnight of the service date (negative = started yesterday). */
  start: number;
  end: number;
  /** Flat [dist, time, dist, time, ...] at each stop; arrival and departure when they differ. */
  stops: number[];
  /** Destination shown to riders. */
  headsign: string;
  /** Flat [station, arrival, departure, ...] per stop, station indexing Network.stations. */
  calls: number[];
  /** GTFS trip_id, for matching realtime updates. */
  gtfsId: string;
  /** The run's GTFS service date: today, or yesterday for runs still going after midnight. */
  startDate: string;
}

/** A place riders know by one name, e.g. Slussen with its metro, bus and ferry stops. */
export interface Station {
  name: string;
  lon: number;
  lat: number;
  /** One bit per mode that stops here today (see MODE_BITS). */
  modes: number;
}

export interface Network {
  serviceDate: string;
  routes: Route[];
  shapes: Shape[];
  /** Sorted by start time. */
  trips: Trip[];
  /** Only stations served today. */
  stations: Station[];
  /** GTFS route_id per route index, and station per GTFS stop_id, for matching realtime alerts. */
  routeIds: string[];
  stopStations: Record<string, number>;
}

export const MODE_BITS: Record<Mode, number> = { bus: 1, metro: 2, tram: 4, rail: 8, ferry: 16 };
// A merged station is placed where its most prominent mode stops.
const MODE_PRIORITY: Mode[] = ["metro", "rail", "tram", "ferry", "bus"];
// Stations with the same name closer than this are one place to riders. Slussen's
// ferry and bus terminals are about 500 m from its metro station.
const MERGE_DISTANCE_M = 600;

const MODES: Record<string, Mode> = {
  "700": "bus", "401": "metro", "900": "tram", "100": "rail", "1000": "ferry",
};

const SIMPLIFY_TOLERANCE_M = 4;
// Bump when the cached network format changes, so old caches are rebuilt.
const CACHE_VERSION = 6;
const DAY = 86_400;

export async function loadNetwork(gtfsDir: string, serviceDate: string): Promise<Network> {
  const cacheName = `network-v${CACHE_VERSION}-${serviceDate}.json`;
  const cachePath = join(config.dataDir, cacheName);
  let network: Network | null = null;
  try {
    const [cache, zip] = await Promise.all([
      stat(cachePath),
      stat(join(config.dataDir, "sl.zip")),
    ]);
    if (cache.mtimeMs > zip.mtimeMs) {
      network = JSON.parse(await readFile(cachePath, "utf8")) as Network;
    }
  } catch {
    // No cache yet.
  }

  if (!network) {
    network = await buildNetwork(gtfsDir, serviceDate);
    await writeFile(cachePath, JSON.stringify(network));
  }
  await removeOtherCaches(cacheName);
  return network;
}

/** Each day's cache is ~30 MB, so only the current one is kept. */
async function removeOtherCaches(keep: string): Promise<void> {
  for (const name of await readdir(config.dataDir)) {
    if (/^network-.*\.json$/.test(name) && name !== keep) {
      await rm(join(config.dataDir, name), { force: true });
    }
  }
}

async function buildNetwork(dir: string, serviceDate: string): Promise<Network> {
  const started = Date.now();

  const routes: Route[] = [];
  const routeIds: string[] = [];
  const routeIndex = new Map<string, number>();
  for await (const r of readCsv(join(dir, "routes.txt"))) {
    routeIndex.set(r.route_id!, routes.length);
    routeIds.push(r.route_id!);
    routes.push({
      name: r.route_short_name || r.route_long_name || "",
      mode: MODES[r.route_type!] ?? "bus",
      desc: r.route_desc ?? "",
    });
  }

  const today = await activeServiceIds(dir, serviceDate);
  const yesterday = await activeServiceIds(dir, previousServiceDate(serviceDate));

  // A trip_id can run both today and yesterday (late at night), so each
  // trip_id maps to one or two time offsets.
  type Pending = {
    gtfsId: string;
    route: number;
    shapeId: string;
    headsign: string;
    offsets: number[];
    stops: number[][];
  };
  const pending = new Map<string, Pending>();
  for await (const t of readCsv(join(dir, "trips.txt"))) {
    const offsets: number[] = [];
    if (today.has(t.service_id!)) offsets.push(0);
    if (yesterday.has(t.service_id!)) offsets.push(-DAY);
    const route = routeIndex.get(t.route_id!);
    if (!offsets.length || route === undefined || !t.shape_id) continue;
    pending.set(t.trip_id!, {
      gtfsId: t.trip_id!,
      route,
      shapeId: t.shape_id,
      headsign: t.trip_headsign ?? "",
      offsets,
      stops: [],
    });
  }

  const places = await readPlaces(dir);

  for await (const st of readCsv(join(dir, "stop_times.txt"))) {
    const trip = pending.get(st.trip_id!);
    if (!trip) continue;
    const arr = parseGtfsTime(st.arrival_time || st.departure_time!);
    const dep = parseGtfsTime(st.departure_time || st.arrival_time!);
    const dist = st.shape_dist_traveled ? Number(st.shape_dist_traveled) : NaN;
    const place = places.stopPlace.get(st.stop_id!) ?? -1;
    if (place >= 0) places.serve(st.stop_id!, routes[trip.route]!.mode);
    trip.stops.push([Number(st.stop_sequence), dist, arr, dep, place]);
  }
  const { stations, stationOf, stopStations } = places.finish();

  const neededShapes = new Set([...pending.values()].map((t) => t.shapeId));
  const rawShapes = new Map<string, { coords: number[]; dist: number[]; seq: number[] }>();
  for await (const s of readCsv(join(dir, "shapes.txt"))) {
    if (!neededShapes.has(s.shape_id!)) continue;
    let shape = rawShapes.get(s.shape_id!);
    if (!shape) rawShapes.set(s.shape_id!, (shape = { coords: [], dist: [], seq: [] }));
    shape.coords.push(Number(s.shape_pt_lon), Number(s.shape_pt_lat));
    shape.dist.push(s.shape_dist_traveled ? Number(s.shape_dist_traveled) : NaN);
    shape.seq.push(Number(s.shape_pt_sequence));
  }

  const shapes: Shape[] = [];
  const shapeIndex = new Map<string, number>();
  const trips: Trip[] = [];
  let skipped = 0;

  for (const trip of pending.values()) {
    const raw = rawShapes.get(trip.shapeId);
    const stops = trip.stops.sort((a, b) => a[0]! - b[0]!);
    if (!raw || stops.length < 2 || stops.some((s) => Number.isNaN(s[1]))) {
      skipped++;
      continue;
    }

    let shape = shapeIndex.get(trip.shapeId);
    if (shape === undefined) {
      shape = shapes.length;
      shapeIndex.set(trip.shapeId, shape);
      shapes.push(prepareShape(raw, trip.route));
    }

    const lastStop = stationOf[stops[stops.length - 1]![4]!];
    const headsign = trip.headsign || (lastStop !== undefined ? stations[lastStop]?.name : "") || "";

    for (const offset of trip.offsets) {
      const flat: number[] = [];
      const calls: number[] = [];
      for (const [, dist, arr, dep, stop] of stops) {
        flat.push(round(dist!, 1), arr! + offset);
        if (dep !== arr) flat.push(round(dist!, 1), dep! + offset);
        calls.push(stationOf[stop!] ?? -1, arr! + offset, dep! + offset);
      }
      const start = flat[1]!;
      const end = flat[flat.length - 1]!;
      // Yesterday's runs only matter if they are still going after midnight.
      if (offset < 0 && end < 0) continue;
      trips.push({
        route: trip.route,
        shape,
        start,
        end,
        stops: flat,
        headsign,
        calls,
        gtfsId: trip.gtfsId,
        startDate: offset < 0 ? previousServiceDate(serviceDate) : serviceDate,
      });
    }
  }

  trips.sort((a, b) => a.start - b.start);
  console.log(
    `Built network for ${serviceDate}: ${trips.length} trips, ${shapes.length} shapes ` +
      `(${skipped} trips skipped) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return { serviceDate, routes, shapes, trips, stations, routeIds, stopStations };
}

/**
 * Reads stops.txt into places: GTFS stations (stop areas), merged when they
 * share a name and lie close together. Platforms map to their place. Call
 * `serve` for every stop time, then `finish` to get the stations served today.
 */
async function readPlaces(dir: string) {
  type Member = { lon: number; lat: number; modes: number };
  type Place = { name: string; members: Member[] };
  const places: Place[] = [];
  const byName = new Map<string, number[]>();
  const memberOf = new Map<string, Member>();
  const stopPlace = new Map<string, number>();
  const parents = new Map<string, string>();

  const addStation = (id: string, name: string, lon: number, lat: number) => {
    const sameName = byName.get(name) ?? [];
    let place = sameName.find((i) =>
      places[i]!.members.some((m) => distanceM(lon, lat, m.lon, m.lat) < MERGE_DISTANCE_M),
    );
    if (place === undefined) {
      place = places.length;
      places.push({ name, members: [] });
      byName.set(name, [...sameName, place]);
    }
    const member = { lon, lat, modes: 0 };
    places[place]!.members.push(member);
    memberOf.set(id, member);
    stopPlace.set(id, place);
  };

  for await (const st of readCsv(join(dir, "stops.txt"))) {
    const id = st.stop_id!;
    const type = st.location_type || "0";
    if (type === "1" || (type === "0" && !st.parent_station)) {
      addStation(id, st.stop_name ?? "", Number(st.stop_lon), Number(st.stop_lat));
    } else if (type === "0") {
      parents.set(id, st.parent_station!);
    }
  }
  for (const [platform, parent] of parents) {
    const place = stopPlace.get(parent);
    if (place === undefined) continue;
    stopPlace.set(platform, place);
    memberOf.set(platform, memberOf.get(parent)!);
  }

  return {
    stopPlace,
    serve(stopId: string, mode: Mode) {
      const member = memberOf.get(stopId);
      if (member) member.modes |= MODE_BITS[mode];
    },
    finish() {
      const stations: Station[] = [];
      // Place index -> station index, or undefined if nothing stops there today.
      const stationOf: (number | undefined)[] = [];
      for (const place of places) {
        const modes = place.members.reduce((m, member) => m | member.modes, 0);
        if (!modes) {
          stationOf.push(undefined);
          continue;
        }
        const top = MODE_PRIORITY.find((mode) => modes & MODE_BITS[mode])!;
        const anchors = place.members.filter((m) => m.modes & MODE_BITS[top]);
        const lon = anchors.reduce((sum, m) => sum + m.lon, 0) / anchors.length;
        const lat = anchors.reduce((sum, m) => sum + m.lat, 0) / anchors.length;
        stationOf.push(stations.length);
        stations.push({ name: place.name, lon: round(lon, 5), lat: round(lat, 5), modes });
      }
      const stopStations: Record<string, number> = {};
      for (const [stop, place] of stopPlace) {
        const station = stationOf[place];
        if (station !== undefined) stopStations[stop] = station;
      }
      return { stations, stationOf, stopStations };
    },
  };
}

function prepareShape(
  raw: { coords: number[]; dist: number[]; seq: number[] },
  route: number,
): Shape {
  // Points are usually in order already, but GTFS doesn't guarantee it.
  const order = raw.seq.map((_, i) => i).sort((a, b) => raw.seq[a]! - raw.seq[b]!);
  const coords = order.flatMap((i) => [raw.coords[i * 2]!, raw.coords[i * 2 + 1]!]);
  let dist = order.map((i) => raw.dist[i]!);

  // Fall back to measured distances if the feed lacks shape_dist_traveled.
  if (dist.some(Number.isNaN)) {
    dist = [0];
    for (let i = 1; i < coords.length / 2; i++) {
      dist.push(dist[i - 1]! + distanceM(
        coords[i * 2 - 2]!, coords[i * 2 - 1]!, coords[i * 2]!, coords[i * 2 + 1]!,
      ));
    }
  }

  const keep = simplifyIndices(coords, SIMPLIFY_TOLERANCE_M);
  return {
    route,
    coords: keep.flatMap((i) => [round(coords[i * 2]!, 5), round(coords[i * 2 + 1]!, 5)]),
    dist: keep.map((i) => round(dist[i]!, 1)),
  };
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Trips that are on the road at some point in [from, to]. The id is the trip's
 * index for the day, so clients can de-duplicate trips across windows.
 */
export function tripsInWindow(network: Network, from: number, to: number) {
  // Headsign and calls are only needed when a vehicle is clicked (see tripDetails).
  return network.trips.flatMap(({ route, shape, start, end, stops }, id) =>
    start <= to && end >= from ? [{ id, route, shape, start, end, stops }] : [],
  );
}

/** Everything the client shows when a vehicle is clicked. */
export function tripDetails(network: Network, id: number) {
  const trip = network.trips[id];
  if (!trip) return null;
  const calls = [];
  for (let i = 0; i < trip.calls.length; i += 3) {
    calls.push({
      name: network.stations[trip.calls[i]!]?.name ?? "",
      arrival: trip.calls[i + 1]!,
      departure: trip.calls[i + 2]!,
    });
  }
  return { id, route: network.routes[trip.route], headsign: trip.headsign, calls };
}

/**
 * Everything the client shows when a station is clicked: how many vehicles
 * stop there today (in total, per hour and per line) and every departure.
 */
export function stationDetails(network: Network, id: number) {
  const station = network.stations[id];
  if (!station) return null;
  let total = 0;
  const hourly = new Array<number>(24).fill(0);
  const lines = new Map<number, number>();
  const headsigns: string[] = [];
  const headsignIndex = new Map<string, number>();
  const departures: [time: number, trip: number, route: number, headsign: number][] = [];

  network.trips.forEach((trip, tripId) => {
    const { calls } = trip;
    let counted = false;
    for (let i = 0; i < calls.length; i += 3) {
      if (calls[i] !== id) continue;
      const time = calls[i + 2]!;
      // Today's calendar day only: yesterday's late trips count, tonight's after midnight don't.
      if (!counted && time >= 0 && time < DAY) {
        counted = true;
        total++;
        hourly[Math.floor(time / 3600)]!++;
        lines.set(trip.route, (lines.get(trip.route) ?? 0) + 1);
      }
      // Riders can't board where the trip ends.
      if (time >= 0 && i + 3 < calls.length) {
        let headsign = headsignIndex.get(trip.headsign);
        if (headsign === undefined) {
          headsign = headsigns.length;
          headsigns.push(trip.headsign);
          headsignIndex.set(trip.headsign, headsign);
        }
        departures.push([time, tripId, trip.route, headsign]);
      }
    }
  });
  departures.sort((a, b) => a[0] - b[0]);

  return {
    id,
    ...station,
    total,
    hourly,
    /** [route, vehicles today], busiest first. */
    lines: [...lines].sort((a, b) => b[1] - a[1]),
    headsigns,
    /** Flat [time, trip, route, headsign, ...] sorted by time; headsign indexes `headsigns`. */
    departures: departures.flat(),
  };
}
