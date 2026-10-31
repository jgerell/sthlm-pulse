// The day's crossings of Trafikverket's road ferries, from FerryAnnouncement.
// Unlike GPS vehicles they follow a timetable, so they work when scrubbing too.
import { config } from "../config.js";
import { query, xml } from "../trafikverket.js";
import { FERRY_ROUTES } from "./routes.js";

// Departures change rarely (a canceled tour, extra tours in summer).
const REFRESH_MS = 30 * 60_000;
// On routes that only list departures from one side ("Vändande"), the ferry
// turns straight back after this long at the far harbor.
const TURNAROUND_S = 60;

interface Announcement {
  DepartureTime: string;
  FromHarbor: { Name: string };
  Route: { Name: string; Type: { Name: string } };
}

export interface Ferries {
  routes: { name: string; harbors: [string, string]; path: [number, number][] }[];
  /** Flat [route, direction, departure, arrival, ...]: direction 0 runs along the route's path, 1 against it. Times in seconds since midnight. */
  trips: number[];
}

let cached: { serviceDate: string; at: number; ferries: Ferries } | null = null;
let fetching: Promise<void> | null = null;

/** The day's ferry crossings. Empty without a Trafikverket key. */
export async function ferriesFor(serviceDate: string): Promise<Ferries> {
  if (!config.trafikverketKey) return { routes: [], trips: [] };
  const fresh = cached?.serviceDate === serviceDate && Date.now() - cached.at < REFRESH_MS;
  if (!fresh) {
    fetching ??= load(serviceDate).finally(() => (fetching = null));
    // Serve the previous day's data only until today's has arrived.
    if (cached?.serviceDate !== serviceDate) await fetching;
  }
  return cached?.serviceDate === serviceDate ? cached.ferries : { routes: [], trips: [] };
}

async function load(serviceDate: string): Promise<void> {
  try {
    const day = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}`;
    const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const rows = await query<Announcement>("FerryAnnouncement", `
      <QUERY objecttype="FerryAnnouncement" schemaversion="1.2">
        <FILTER><AND>
          <IN name="Route.Name" value="${xml(FERRY_ROUTES.map((r) => r.name).join(","))}"/>
          <GTE name="DepartureTime" value="${day}T00:00:00"/>
          <LT name="DepartureTime" value="${next}T00:00:00"/>
        </AND></FILTER>
        <INCLUDE>DepartureTime</INCLUDE><INCLUDE>FromHarbor.Name</INCLUDE>
        <INCLUDE>Route.Name</INCLUDE><INCLUDE>Route.Type.Name</INCLUDE>
      </QUERY>`);
    const index = new Map(FERRY_ROUTES.map((r, i) => [r.name, i]));
    const trips: number[] = [];
    for (const row of rows) {
      const routeIndex = index.get(row.Route.Name);
      if (routeIndex === undefined || !row.DepartureTime.startsWith(day)) continue;
      const route = FERRY_ROUTES[routeIndex]!;
      const direction = route.harbors.indexOf(row.FromHarbor.Name);
      if (direction < 0) continue;
      // Local time as written, e.g. "2026-10-31T18:30:00.000+01:00".
      const departure = Number(row.DepartureTime.slice(11, 13)) * 3600 + Number(row.DepartureTime.slice(14, 16)) * 60;
      const arrival = departure + route.crossingS;
      trips.push(routeIndex, direction, departure, arrival);
      if (row.Route.Type.Name === "Vändande") {
        const back = arrival + TURNAROUND_S;
        trips.push(routeIndex, 1 - direction, back, back + route.crossingS);
      }
    }
    cached = {
      serviceDate,
      at: Date.now(),
      ferries: {
        routes: FERRY_ROUTES.map(({ name, harbors, path }) => ({ name, harbors, path })),
        trips,
      },
    };
  } catch (err) {
    console.error("Could not fetch ferry departures:", err);
    // Keep serving what we have; try again after the usual interval.
    if (cached) cached.at = Date.now();
  }
}
