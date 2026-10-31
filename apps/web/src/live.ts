// Vehicles placed by GPS rather than the timetable (regional and long-distance
// trains so far). Positions arrive every 10-15 s and some way behind, so the map
// shows these vehicles a little in the past and moves them between real fixes:
// they always follow the track instead of guessing ahead and correcting. Between
// two fixes the path curves along the bearings measured at each end, so
// a train follows a bend instead of cutting a straight chord across it.
import type { LiveVehicle } from "./api";
import { escapeHtml } from "./format";
import { REGIONAL_PICTOGRAM, SHIP_PICTOGRAM } from "./pictograms";

/** How far behind real time GPS vehicles are drawn, so the next fix is usually in. */
export const LIVE_LAG_S = 30;
// Fixes kept per vehicle, for the trail.
const HISTORY_S = 600;
// Points drawn per stretch between two fixes.
const SEGMENT_STEPS = 8;
const M_PER_DEG_LAT = 111_320;
// Timestamps are relative to page load: deck.gl keeps them as 32-bit floats,
// which can't hold Unix seconds precisely.
const BASE = Math.floor(Date.now() / 1000);

interface Fix {
  lon: number;
  lat: number;
  /** Relative to BASE. */
  time: number;
  bearing: number | null;
}

export interface LiveTrack {
  vehicle: LiveVehicle;
  /** GPS fixes so far, oldest first. */
  fixes: Fix[];
  /** The curve through the fixes, sampled, with times; drawn as the trail. */
  path: [number, number][];
  timestamps: number[];
  /** Where the vehicle is drawn now. */
  position: [number, number];
}

export const tracks = new Map<string, LiveTrack>();

/** Takes in a new batch of positions; vehicles missing from it are dropped. */
export function updateTracks(vehicles: LiveVehicle[]): void {
  const seen = new Set<string>();
  for (const vehicle of vehicles) {
    seen.add(vehicle.id);
    const fix: Fix = {
      lon: vehicle.lon,
      lat: vehicle.lat,
      time: vehicle.time - BASE,
      bearing: vehicle.bearing,
    };
    const track = tracks.get(vehicle.id);
    if (!track) {
      const position: [number, number] = [fix.lon, fix.lat];
      tracks.set(vehicle.id, { vehicle, fixes: [fix], path: [position], timestamps: [fix.time], position });
      continue;
    }
    track.vehicle = vehicle;
    const last = track.fixes[track.fixes.length - 1]!;
    if (fix.time <= last.time) continue;
    track.fixes.push(fix);
    for (let k = 1; k <= SEGMENT_STEPS; k++) {
      const f = k / SEGMENT_STEPS;
      track.path.push(curve(last, fix, f));
      track.timestamps.push(last.time + f * (fix.time - last.time));
    }
    while (track.fixes.length > 2 && track.fixes[0]!.time < fix.time - HISTORY_S) {
      track.fixes.shift();
      track.path.splice(0, SEGMENT_STEPS);
      track.timestamps.splice(0, SEGMENT_STEPS);
    }
  }
  for (const id of tracks.keys()) if (!seen.has(id)) tracks.delete(id);
}

/** The time GPS vehicles are drawn at, on the same clock as their timestamps. */
export function liveTime(): number {
  return Date.now() / 1000 - BASE - LIVE_LAG_S;
}

/** Moves every vehicle to where it was at liveTime(), between its two fixes. */
export function advanceTracks(): void {
  const t = liveTime();
  for (const track of tracks.values()) {
    const { fixes } = track;
    const i = fixes.findIndex((fix) => fix.time > t);
    if (i === 0) {
      track.position = [fixes[0]!.lon, fixes[0]!.lat];
    } else if (i === -1) {
      // Past the latest fix: wait there for the next one.
      const last = fixes[fixes.length - 1]!;
      track.position = [last.lon, last.lat];
    } else {
      const a = fixes[i - 1]!;
      const b = fixes[i]!;
      track.position = curve(a, b, (t - a.time) / (b.time - a.time));
    }
  }
}

/**
 * The point a fraction f of the way from fix a to fix b, on a cubic Hermite
 * curve leaving a and reaching b in their measured directions. Where a
 * direction is missing or points away from b (GPS noise, standing still), the
 * straight line between the fixes stands in for it.
 */
function curve(a: Fix, b: Fix, f: number): [number, number] {
  const kx = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  // Work in meters east and north of a.
  const bx = (b.lon - a.lon) * kx;
  const by = (b.lat - a.lat) * M_PER_DEG_LAT;
  const chord = Math.hypot(bx, by);
  const tangent = (fix: Fix): [number, number] => {
    if (fix.bearing === null || !chord) return [bx, by];
    const rad = (fix.bearing * Math.PI) / 180;
    const [ux, uy] = [Math.sin(rad), Math.cos(rad)];
    if (ux * bx + uy * by < 0.5 * chord) return [bx, by];
    return [ux * chord, uy * chord];
  };
  const [ax1, ay1] = tangent(a);
  const [bx1, by1] = tangent(b);
  const f2 = f * f;
  const f3 = f2 * f;
  const h10 = f3 - 2 * f2 + f;
  const h01 = -2 * f3 + 3 * f2;
  const h11 = f3 - f2;
  const x = h10 * ax1 + h01 * bx + h11 * bx1;
  const y = h10 * ay1 + h01 * by + h11 * by1;
  return [a.lon + x / kx, a.lat + y / M_PER_DEG_LAT];
}

/** The info card for a clicked train or ship. */
export function liveCardHtml(v: LiveVehicle, badge: string, close: string): string {
  const age = Math.max(0, Math.round(Date.now() / 1000 - v.time));
  const ship = v.kind === "ship";
  const subtitle = ship
    ? [v.operator, v.length ? `${v.length} m` : "", v.to ? `mot ${escapeHtml(v.to)}` : ""].filter(Boolean).join(" · ")
    : v.from && v.to ? `${escapeHtml(v.from)} → ${escapeHtml(v.to)}` : "Okänd sträcka";
  // Ships' speed is given in knots, as at sea.
  const speed = v.speed === null
    ? "Hastighet okänd"
    : ship ? `<strong>${(v.speed / 1.852).toFixed(1).replace(".", ",")} knop</strong>` : `<strong>${Math.round(v.speed)} km/h</strong>`;
  return `<header class="vehicle__header">
      <span class="vehicle__badge live__badge" style="${badge}">${ship ? SHIP_PICTOGRAM : REGIONAL_PICTOGRAM}</span>
      <div class="vehicle__title">
        <div class="vehicle__dest">${escapeHtml(v.name)}</div>
        <div class="vehicle__mode">${subtitle}</div>
      </div>
      ${close}
    </header>
    <div class="vehicle__status">
      ${speed}
      <span class="vehicle__eta">${ship ? "AIS" : "GPS"} ${age < 60 ? `${age} s` : `${Math.round(age / 60)} min`} sedan</span>
    </div>
    <footer class="vehicle__foot">
      Position från ${ship ? "AISStream" : "Trafikverket"}, visad ${LIVE_LAG_S} s i efterhand · syns bara i live-läge
    </footer>`;
}
