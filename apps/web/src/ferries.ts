// Trafikverket's road ferries (Vaxholmsleden, Ljusteröleden...). They run to a
// timetable, so like SL's vehicles they follow the clock when scrubbing.
import type { Ferries } from "./api";
import { escapeHtml, formatHm } from "./format";
import { ROAD_FERRY_PICTOGRAM } from "./pictograms";

export interface FerryTrip {
  id: number;
  route: string;
  from: string;
  to: string;
  start: number;
  end: number;
  path: [number, number][];
  timestamps: number[];
}

/** One trip per crossing, moving along the route at an even pace. */
export function buildFerryTrips(ferries: Ferries): FerryTrip[] {
  const lengths = ferries.routes.map((r) => cumulative(r.path));
  const trips: FerryTrip[] = [];
  for (let i = 0; i < ferries.trips.length; i += 4) {
    const route = ferries.routes[ferries.trips[i]!]!;
    const along = lengths[ferries.trips[i]!]!;
    const direction = ferries.trips[i + 1]!;
    const start = ferries.trips[i + 2]!;
    const end = ferries.trips[i + 3]!;
    const total = along[along.length - 1]!;
    const forward = direction === 0;
    const path = forward ? route.path : [...route.path].reverse();
    const timestamps = (forward ? along : along.map((d) => total - d).reverse())
      .map((d) => start + (d / (total || 1)) * (end - start));
    trips.push({
      id: i / 4,
      route: route.name,
      from: route.harbors[direction]!,
      to: route.harbors[1 - direction]!,
      start,
      end,
      path,
      timestamps,
    });
  }
  return trips;
}

/** Distance along a path at each point, scaled for Stockholm's latitude (only ratios matter). */
function cumulative(path: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1]!, path[i]!];
    out.push(out[i - 1]! + Math.hypot((b[0] - a[0]) * 0.5, b[1] - a[1]));
  }
  return out;
}

export function ferryCardHtml(trip: FerryTrip, badge: string, close: string): string {
  return `<header class="vehicle__header">
      <span class="vehicle__badge live__badge" style="${badge}">${ROAD_FERRY_PICTOGRAM}</span>
      <div class="vehicle__title">
        <div class="vehicle__dest">${escapeHtml(trip.route)}</div>
        <div class="vehicle__mode">${escapeHtml(trip.from)} → ${escapeHtml(trip.to)}</div>
      </div>
      ${close}
    </header>
    <div class="vehicle__status">
      Avgick <strong>${formatHm(trip.start)}</strong>
      <span class="vehicle__eta">framme ${formatHm(trip.end)}</span>
    </div>
    <footer class="vehicle__foot">Trafikverkets vägfärjor · enligt tidtabell</footer>`;
}
