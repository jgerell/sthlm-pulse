// Disruptions in the info cards, and the "Idag i siffror" tiles.
import type { Alert, DailyStats, Delays, Route } from "./api";
import { escapeHtml, formatHm } from "./format";
import { MODES } from "./palette";
import { INFO_PICTOGRAM, WARNING_PICTOGRAM } from "./pictograms";

const EARTH_CIRCUMFERENCE_KM = 40_075;
const TOOLTIP_ALERTS_SHOWN = 3;

// SL's alerts carry no type, so it's read from the header, falling back to the cause.
const TYPES: [RegExp, string][] = [
  [/inställ/i, "Inställd trafik"],
  [/försen/i, "Förseningar"],
  [/\b(hiss|hissar|rulltrappa|rulltrappor)\b/i, "Hiss eller rulltrappa"],
  [/flyttad/i, "Flyttad hållplats"],
  [/indrag|stannar (inte|ej)/i, "Hållplatsen trafikeras inte"],
  [/extrainsatt|extra avgång/i, "Extra avgångar"],
  [/evenemang/i, "Evenemang"],
  [/omled|ändrad|ersättningsbuss|går via/i, "Ändrad trafik"],
];
const CAUSES: Record<string, string> = {
  TECHNICAL_PROBLEM: "Tekniskt fel",
  ACCIDENT: "Olycka",
  POLICE_ACTIVITY: "Polisinsats",
  MEDICAL_EMERGENCY: "Sjukdomsfall",
  WEATHER: "Väder",
  STRIKE: "Strejk",
  DEMONSTRATION: "Demonstration",
  CONSTRUCTION: "Arbete",
  MAINTENANCE: "Arbete",
  HOLIDAY: "Helgtrafik",
};

function alertType(alert: Alert): string {
  return TYPES.find(([pattern]) => pattern.test(alert.header))?.[1] ?? CAUSES[alert.cause] ?? "Information";
}

/** A small sign tile: the warning triangle when acute, an "i" for planned changes. */
function alertTile(alert: Alert): string {
  return `<span class="alert-tile">${alert.acute ? WARNING_PICTOGRAM : INFO_PICTOGRAM}</span>`;
}

/** Shown when hovering a station's warning icon. */
export function warningTooltipHtml(station: string, alerts: Alert[]): string {
  const items = alerts
    .slice(0, TOOLTIP_ALERTS_SHOWN)
    .map((a) => `<li class="alert-row${a.acute ? " is-acute" : ""}">
        ${alertTile(a)}
        <span>${escapeHtml(a.header)} <span class="alert-tag">${alertType(a)}</span></span>
      </li>`)
    .join("");
  const more = alerts.length - TOOLTIP_ALERTS_SHOWN;
  return `<div class="map-tooltip">
      <strong>${escapeHtml(station)}</strong>
      <ul>${items}</ul>
      ${more > 0 ? `<span class="map-tooltip__more">+${more} till</span>` : ""}
      <span class="map-tooltip__hint">Klicka för detaljer</span>
    </div>`;
}

/**
 * Alerts in a card, newest acute first. Descriptions start as two lines so the
 * departures keep their room; "Visa mer" opens one in full. `expanded` holds the
 * headers opened, since the card is re-rendered as time passes.
 */
export function cardAlertsHtml(alerts: Alert[], expanded: Set<string>): string {
  if (!alerts.length) return "";
  return `<ul class="card-alerts">${alerts
    .map((a) => {
      const open = expanded.has(a.header);
      const description = a.description && a.description !== a.header
        ? `<p class="${open ? "is-open" : ""}">${escapeHtml(a.description)}</p>
           <button class="card-alert__more" type="button" data-alert="${escapeHtml(a.header)}"
             aria-expanded="${open}">${open ? "Visa mindre" : "Visa mer"}</button>`
        : "";
      return `<li class="card-alert alert-row${a.acute ? " is-acute" : ""}">
        ${alertTile(a)}
        <div>
          <strong>${escapeHtml(a.header)}</strong>
          <span class="alert-tag">${alertType(a)}</span>
          ${description}
        </div>
      </li>`;
    })
    .join("")}</ul>`;
}

function routeLabel(route: Route): string {
  return `${MODES[route.mode].label} ${route.name}`;
}

function tile(label: string, value: string, sub: string): string {
  return `<li class="stat">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value}</span>
      <span class="stat__sub">${sub}</span>
    </li>`;
}

const number = (n: number) => n.toLocaleString("sv-SE");

/** "Idag i siffror": timetable facts, plus realtime ones when there are any. */
export function statsHtml(stats: DailyStats, routes: Route[], rt: Delays | null): string {
  const laps = (stats.distanceKm / EARTH_CIRCUMFERENCE_KM).toLocaleString("sv-SE", {
    maximumFractionDigits: 1,
  });
  const longest = stats.longestTrip;
  const hours = Math.floor(longest.minutes / 60);
  const duration = hours ? `${hours} h ${longest.minutes % 60} min` : `${longest.minutes} min`;
  const busiestLine = routes[stats.busiestLine.route]!;
  const longestRoute = routes[longest.route]!;

  const tiles = [
    tile("Turer idag", number(stats.trips), "enligt tidtabell"),
    tile("Körd sträcka", `${number(stats.distanceKm)} km`, `${laps} varv runt jorden`),
    tile("Rusningstopp", formatHm(stats.peak.time), `${number(stats.peak.vehicles)} fordon samtidigt`),
    tile("Mest trafikerad", escapeHtml(stats.busiestStation.name), `${number(stats.busiestStation.vehicles)} fordon`),
    tile("Flitigaste linjen", escapeHtml(routeLabel(busiestLine)), `${number(stats.busiestLine.trips)} turer`),
    tile("Längsta turen", duration, escapeHtml(`${routeLabel(longestRoute)}, ${longest.from} → ${longest.headsign}`)),
  ];
  if (rt?.onTimeShare != null) {
    tiles.push(tile("I tid just nu", `${Math.round(rt.onTimeShare * 100)} %`, "inom 3 min från tidtabellen"));
  }
  if (rt?.latest && rt.latest.delay >= 60) {
    const route = routes[rt.latest.route]!;
    tiles.push(tile(
      "Mest försenad",
      `+${Math.round(rt.latest.delay / 60)} min`,
      escapeHtml(`${routeLabel(route)} mot ${rt.latest.headsign}`),
    ));
  }
  return tiles.join("");
}
