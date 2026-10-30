// Realtime delays from GTFS-RT TripUpdates. Vehicles are still animated along
// the timetable, just shifted by how late (or early) each trip is running, so
// they keep moving smoothly between updates.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { Network } from "../schedule/network.js";
import { cachedFeed } from "./feeds.js";

// At most 720 requests a day; see feeds.ts for the quota.
const tripUpdates = cachedFeed("TripUpdates", 120_000);
// Ignore implausible predictions rather than throw vehicles far off.
const MIN_DELAY_S = -300;
const MAX_DELAY_S = 2 * 3600;
// Within this many seconds of the timetable counts as on time.
const ON_TIME_S = 180;

const { FeedMessage, TripDescriptor } = GtfsRealtimeBindings.transit_realtime;

export interface Delays {
  /** When the feed was generated (Unix seconds). */
  updatedAt: number;
  /** Seconds late per trip id (negative = early). */
  delays: Map<number, number>;
  canceled: Set<number>;
  /** Share of trips with realtime data within 3 minutes of the timetable. */
  onTimeShare: number;
  /** The trip running latest right now. */
  latest: { trip: number; delay: number } | null;
}

// Parsed delays are cached per feed and network, since both change rarely.
let parsed: { buffer: Buffer; network: Network; delays: Delays } | null = null;

/** Current delays for the network, refreshing the feed if it's due. Null if realtime is off. */
export async function currentDelays(network: Network): Promise<Delays | null> {
  const buffer = await tripUpdates.get();
  if (!buffer) return null;
  if (parsed?.buffer !== buffer || parsed.network !== network) {
    parsed = { buffer, network, delays: parseDelays(buffer, network) };
  }
  return parsed.delays;
}

/** Trip ids by `${GTFS trip_id}/${start date}`, as realtime feeds identify runs. */
export function tripIndex(network: Network): Map<string, number> {
  const index = new Map<string, number>();
  network.trips.forEach((trip, id) => index.set(`${trip.gtfsId}/${trip.startDate}`, id));
  return index;
}

function parseDelays(buffer: Buffer, network: Network): Delays {
  const message = FeedMessage.decode(buffer);
  const index = tripIndex(network);

  const delays = new Map<number, number>();
  const canceled = new Set<number>();
  for (const entity of message.entity) {
    const update = entity.tripUpdate;
    const descriptor = update?.trip;
    if (!update || !descriptor?.tripId) continue;
    const id = index.get(`${descriptor.tripId}/${descriptor.startDate ?? network.serviceDate}`);
    if (id === undefined) continue;

    if (descriptor.scheduleRelationship === TripDescriptor.ScheduleRelationship.CANCELED) {
      canceled.add(id);
      continue;
    }
    // Updates for passed stops are dropped, so the first one is the next stop.
    const next = update.stopTimeUpdate?.find((s) => s.departure || s.arrival);
    const delay = next?.departure?.delay ?? next?.arrival?.delay;
    if (delay == null) continue;
    delays.set(id, Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, delay)));
  }

  let onTime = 0;
  let latest: Delays["latest"] = null;
  for (const [trip, delay] of delays) {
    if (Math.abs(delay) <= ON_TIME_S) onTime++;
    if (!latest || delay > latest.delay) latest = { trip, delay };
  }
  return {
    updatedAt: Number(message.header.timestamp),
    delays,
    canceled,
    onTimeShare: delays.size ? onTime / delays.size : 1,
    latest,
  };
}
