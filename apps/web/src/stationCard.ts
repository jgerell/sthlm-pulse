// The info card shown when a station is clicked: how many vehicles stop there
// today, when during the day, and the next departures from the current time
// (with realtime delays when there are any).
import { MODE_BITS, type Mode, type Route, type StationDetails } from "./api";
import { escapeHtml, formatHm } from "./format";
import { badgeStyle, color, colorKey, MODES, type Theme } from "./palette";

const DEPARTURES_SHOWN = 8;
const LINES_SHOWN = 16;
// A departure stays listed as "Nu" until it is this many seconds old.
const DEPARTED_GRACE_S = 20;
// Late vehicles leave well after their timetable time, so look back this far,
// and no further ahead than this.
const LOOKBACK_S = 30 * 60;
const LOOKAHEAD_S = 3 * 3600;
// Order in which a station's modes are listed.
const LABEL_ORDER: Mode[] = ["metro", "rail", "tram", "ferry", "bus"];

/** Index of the first departure at or after time t in the flat departures array. */
function firstDeparture(departures: number[], t: number): number {
  let lo = 0;
  let hi = departures.length / 4;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (departures[mid * 4]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Realtime {
  /** Seconds late, or undefined without realtime data for the trip. */
  delay(trip: number): number | undefined;
  canceled(trip: number): boolean;
}

interface Departure {
  /** Expected time: timetable plus delay. */
  time: number;
  trip: number;
  route: number;
  headsign: number;
  delay: number;
  canceled: boolean;
}

/** The next departures by expected time. */
function nextDepartures(details: StationDetails, t: number, rt: Realtime): Departure[] {
  const { departures } = details;
  const found: Departure[] = [];
  for (let i = firstDeparture(departures, t - LOOKBACK_S); i * 4 < departures.length; i++) {
    const scheduled = departures[i * 4]!;
    if (scheduled > t + LOOKAHEAD_S) break;
    const trip = departures[i * 4 + 1]!;
    const delay = rt.delay(trip) ?? 0;
    const time = scheduled + delay;
    if (time < t - DEPARTED_GRACE_S) continue;
    found.push({
      time,
      trip,
      route: departures[i * 4 + 2]!,
      headsign: departures[i * 4 + 3]!,
      delay,
      canceled: rt.canceled(trip),
    });
  }
  return found.sort((a, b) => a.time - b.time).slice(0, DEPARTURES_SHOWN);
}

/** Trip ids of the next departures, so their vehicles can be marked on the map. */
export function upcomingTrips(details: StationDetails, t: number, rt: Realtime): number[] {
  return nextDepartures(details, t, rt).filter((d) => !d.canceled).map((d) => d.trip);
}

function countdown(time: number, t: number): string {
  const minutes = Math.round((time - t) / 60);
  if (minutes <= 0) return "Nu";
  if (minutes < 60) return `${minutes} min`;
  return formatHm(time);
}

export function stationCardHtml(
  details: StationDetails,
  routes: Route[],
  theme: Theme,
  t: number,
  close: string,
  /** Whether a trip's vehicle is loaded, so its departure can open the vehicle card. */
  canSelect: (trip: number) => boolean,
  rt: Realtime,
  /** Disruptions at this station, already rendered. */
  alerts: string,
): string {
  const badge = (route: number) => badgeStyle(color(theme, colorKey(routes[route]!)));
  const modes = LABEL_ORDER.filter((m) => details.modes & MODE_BITS[m])
    .map((m) => MODES[m].label)
    .join(" · ");

  // Vehicles per hour as bars, with the hours already passed filled in.
  const hour = Math.floor((((t % 86_400) + 86_400) % 86_400) / 3600);
  const peak = Math.max(1, ...details.hourly);
  const bars = details.hourly
    .map((n, h) => {
      const state = h === hour ? "is-now" : h < hour ? "is-past" : "";
      return `<i class="${state}" style="--h: ${n / peak}" title="${String(h).padStart(2, "0")}: ${n} fordon"></i>`;
    })
    .join("");

  const next = nextDepartures(details, t, rt);
  const live = next.some((d) => rt.delay(d.trip) !== undefined || d.canceled);
  const rows = next.map((d) => {
    // Departures whose vehicle isn't loaded yet (or never comes) can't open its card.
    const tag = canSelect(d.trip) && !d.canceled ? "button" : "div";
    const late = Math.round(d.delay / 60);
    const when = d.canceled
      ? `<span class="departure__canceled">Inställd</span>`
      : `${late > 0 ? `<span class="departure__late">+${late}</span>` : ""}${countdown(d.time, t)}`;
    return `<li><${tag} class="departure${d.canceled ? " is-canceled" : ""}" data-trip="${d.trip}" style="${badge(d.route)}">
        <span class="departure__line">${escapeHtml(routes[d.route]!.name)}</span>
        <span class="departure__dest">${escapeHtml(details.headsigns[d.headsign]!)}</span>
        <span class="departure__when">${when}</span>
      </${tag}></li>`;
  });

  const lines = details.lines
    .slice(0, LINES_SHOWN)
    .map(([route, n]) =>
      `<span class="station__line" style="${badge(route)}" title="${n} fordon idag">${escapeHtml(routes[route]!.name)}</span>`)
    .join("");
  const moreLines = details.lines.length - LINES_SHOWN;

  return `<header class="vehicle__header">
      <span class="station__icon" aria-hidden="true"></span>
      <div class="vehicle__title">
        <div class="vehicle__dest">${escapeHtml(details.name)}</div>
        <div class="vehicle__mode">${modes}</div>
      </div>
      ${close}
    </header>
    ${alerts}
    <div class="station__stat">
      <strong>${details.total.toLocaleString("sv-SE")}</strong>
      <span>fordon passerar idag</span>
    </div>
    <div class="station__hours" aria-hidden="true">${bars}</div>
    <div class="station__ticks" aria-hidden="true">
      <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
    </div>
    <h3 class="station__heading">Nästa avgångar</h3>
    ${rows.length
      ? `<ol class="departures">${rows.join("")}</ol>`
      : `<p class="station__empty">Inga fler avgångar idag</p>`}
    <h3 class="station__heading">Linjer</h3>
    <div class="station__lines">${lines}${moreLines > 0 ? `<span class="station__more">+${moreLines}</span>` : ""}</div>
    <footer class="vehicle__foot">${live ? "Avgångar enligt realtid" : "Enligt tidtabell"}</footer>`;
}
