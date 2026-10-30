// Facts about the day's timetable, shown as "Idag i siffror". Computed once per
// network, since the timetable doesn't change during the day.
import type { Network } from "./network.js";

const DAY = 86_400;

export interface DailyStats {
  /** Runs of today's service. */
  trips: number;
  /** Distance driven by all of them together. */
  distanceKm: number;
  /** When the most vehicles are on the road at once. */
  peak: { time: number; vehicles: number };
  busiestStation: { name: string; vehicles: number };
  busiestLine: { route: number; trips: number };
  longestTrip: { route: number; headsign: string; from: string; minutes: number };
}

export function dailyStats(network: Network): DailyStats {
  const today = network.trips.filter((t) => t.startDate === network.serviceDate);

  let meters = 0;
  const perLine = new Map<number, number>();
  let longest = today[0]!;
  for (const trip of today) {
    meters += trip.stops[trip.stops.length - 2]! - trip.stops[0]!;
    perLine.set(trip.route, (perLine.get(trip.route) ?? 0) + 1);
    if (trip.end - trip.start > longest.end - longest.start) longest = trip;
  }
  const [busiestRoute, busiestCount] = [...perLine].reduce((a, b) => (b[1] > a[1] ? b : a));

  // Vehicles on the road over the calendar day: +1 at each start, -1 at each end.
  const events: [time: number, change: number][] = [];
  for (const trip of network.trips) {
    if (trip.end < 0 || trip.start >= DAY) continue;
    events.push([Math.max(0, trip.start), 1], [trip.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  const peak = { time: 0, vehicles: 0 };
  for (const [time, change] of events) {
    running += change;
    if (running > peak.vehicles) Object.assign(peak, { time, vehicles: running });
  }

  // Vehicles stopping at each station during the calendar day, once per trip.
  const perStation = new Array<number>(network.stations.length).fill(0);
  for (const trip of network.trips) {
    const seen = new Set<number>();
    for (let i = 0; i < trip.calls.length; i += 3) {
      const station = trip.calls[i]!;
      const time = trip.calls[i + 2]!;
      if (station < 0 || time < 0 || time >= DAY || seen.has(station)) continue;
      seen.add(station);
      perStation[station]!++;
    }
  }
  const busiest = perStation.reduce((best, n, i) => (n > perStation[best]! ? i : best), 0);

  return {
    trips: today.length,
    distanceKm: Math.round(meters / 1000),
    peak,
    busiestStation: { name: network.stations[busiest]!.name, vehicles: perStation[busiest]! },
    busiestLine: { route: busiestRoute, trips: busiestCount },
    longestTrip: {
      route: longest.route,
      headsign: longest.headsign,
      from: network.stations[longest.calls[0]!]?.name ?? "",
      minutes: Math.round((longest.end - longest.start) / 60),
    },
  };
}
