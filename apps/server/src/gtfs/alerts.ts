// Disruptions from GTFS-RT ServiceAlerts, matched to our routes, stations and
// trips. SL marks neither severity nor effect, so alerts are split by cause and
// duration: incidents and anything lasting at most a day are "acute" and shown
// on the map; long planned changes (moved stops, elevator work) only in cards.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { Network } from "../schedule/network.js";
import { cachedFeed } from "./feeds.js";
import { tripIndex } from "./realtime.js";

// Alerts change slowly: at most 96 requests a day; see feeds.ts for the quota.
const serviceAlerts = cachedFeed("ServiceAlerts", 15 * 60_000);
const ACUTE_MAX_DURATION_S = 24 * 3600;
// Station facilities don't disrupt traffic: shown at the station, never as acute.
const FACILITY = /\b(hiss|hissar|rulltrappa|rulltrappor)\b/i;
// SL sometimes publishes test messages in the live feed.
const TEST = /\btest\b/i;

const { FeedMessage, Alert: AlertMessage } = GtfsRealtimeBindings.transit_realtime;
const Cause = AlertMessage.Cause;
const INCIDENT_CAUSES = new Set<number>([
  Cause.TECHNICAL_PROBLEM, Cause.STRIKE, Cause.DEMONSTRATION, Cause.ACCIDENT,
  Cause.WEATHER, Cause.POLICE_ACTIVITY, Cause.MEDICAL_EMERGENCY,
]);

export interface Alert {
  /** GTFS-RT cause, e.g. "TECHNICAL_PROBLEM". */
  cause: string;
  header: string;
  description: string;
  /** Unix seconds; null when open-ended. */
  start: number | null;
  end: number | null;
  acute: boolean;
  routes: number[];
  stations: number[];
  trips: number[];
}

let parsed: { buffer: Buffer; network: Network; alerts: Alert[] } | null = null;

/** Alerts active right now, acute first. Empty if realtime is off. */
export async function currentAlerts(network: Network): Promise<Alert[]> {
  const buffer = await serviceAlerts.get();
  if (!buffer) return [];
  if (parsed?.buffer !== buffer || parsed.network !== network) {
    parsed = { buffer, network, alerts: parseAlerts(buffer, network) };
  }
  const now = Date.now() / 1000;
  return parsed.alerts.filter((a) => (a.start ?? 0) <= now && now <= (a.end ?? Infinity));
}

function parseAlerts(buffer: Buffer, network: Network): Alert[] {
  const message = FeedMessage.decode(buffer);
  const routeIndex = new Map(network.routeIds.map((id, i) => [id, i]));
  const trips = tripIndex(network);
  const text = (t: GtfsRealtimeBindings.transit_realtime.ITranslatedString | null | undefined) =>
    t?.translation?.[0]?.text?.trim() ?? "";

  const alerts: Alert[] = [];
  for (const entity of message.entity) {
    const alert = entity.alert;
    if (!alert) continue;
    const header = text(alert.headerText);
    if (TEST.test(header)) continue;
    const routes = new Set<number>();
    const stations = new Set<number>();
    const tripIds = new Set<number>();
    for (const informed of alert.informedEntity ?? []) {
      const route = informed.routeId ? routeIndex.get(informed.routeId) : undefined;
      if (route !== undefined) routes.add(route);
      const station = informed.stopId ? network.stopStations[informed.stopId] : undefined;
      if (station !== undefined) stations.add(station);
      const tripId = informed.trip?.tripId;
      if (tripId) {
        const date = informed.trip?.startDate ?? network.serviceDate;
        const trip = trips.get(`${tripId}/${date}`);
        if (trip !== undefined) {
          tripIds.add(trip);
          routes.add(network.trips[trip]!.route);
        }
      }
    }
    if (!routes.size && !stations.size && !tripIds.size) continue;

    // An alert can have several periods; the earliest start and latest end are enough here.
    const periods = alert.activePeriod ?? [];
    const starts = periods.map((p) => Number(p.start ?? 0)).filter(Boolean);
    const ends = periods.map((p) => Number(p.end ?? 0)).filter(Boolean);
    const start = starts.length ? Math.min(...starts) : null;
    const end = ends.length && ends.length === periods.length ? Math.max(...ends) : null;
    const short = start !== null && end !== null && end - start <= ACUTE_MAX_DURATION_S;

    const cause = alert.cause ?? Cause.UNKNOWN_CAUSE;
    alerts.push({
      cause: Cause[cause] ?? "UNKNOWN_CAUSE",
      header,
      description: text(alert.descriptionText),
      start,
      end,
      acute: !FACILITY.test(header) && (INCIDENT_CAUSES.has(cause) || short),
      routes: [...routes],
      stations: [...stations],
      trips: [...tripIds],
    });
  }
  // Acute first, newest first.
  return alerts.sort((a, b) => Number(b.acute) - Number(a.acute) || (b.start ?? 0) - (a.start ?? 0));
}
