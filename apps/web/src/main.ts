import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { Map as MapLibreMap, type ExpressionSpecification } from "maplibre-gl";
import {
  fetchAlerts,
  fetchDelays,
  fetchFerries,
  fetchLive,
  fetchNetwork,
  fetchStation,
  fetchTripDetails,
  fetchTrips,
  MODE_BITS,
  type Alert,
  type Delays,
  type Mode,
  type Network,
  type StationDetails,
  type TripDetails,
} from "./api";
import { delayBadge, escapeHtml, formatClock, formatHm } from "./format";
import {
  badgeStyle,
  color,
  colorKey,
  MODE_ORDER,
  MODES,
  THEME_LABELS,
  THEME_ORDER,
  THEMES,
  type ColorKey,
  type Theme,
  type ThemeChoice,
} from "./palette";
import { cardAlertsHtml, statsHtml, warningTooltipHtml } from "./info";
import { buildFerryTrips, ferryCardHtml, type FerryTrip } from "./ferries";
import { advanceTracks, liveCardHtml, liveTime, tracks, updateTracks, type LiveTrack } from "./live";
import { PICTOGRAMS, REGIONAL_PICTOGRAM, ROAD_FERRY_PICTOGRAM, SHIP_PICTOGRAM } from "./pictograms";
import { stationCardHtml, upcomingTrips, type Realtime } from "./stationCard";
import { applyDelay, buildAnimatedTrip, positionAt, type AnimatedTrip } from "./trips";

const CHUNK_S = 3600;
const MIN_LOOKAHEAD_S = 20 * 60;

const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5a.8.8 0 0 0-1.2.7Z" /></svg>`;
// Delays are cheap to fetch from our server, which itself polls SL every 2 min.
const DELAYS_POLL_MS = 60_000;
// Load trips that ended this long ago by the timetable, in case they're running late.
const DELAY_LOOKBACK_S = 15 * 60;
// Our server refreshes alerts from SL every 15 min at most.
const ALERTS_POLL_MS = 5 * 60_000;
const CARD_ALERTS_SHOWN = 3;
// The server asks Trafikverket at most every 10 s, so asking it more often gains nothing.
const LIVE_POLL_MS = 10_000;
const FERRIES_POLL_MS = 30 * 60_000;
const THEME_STORAGE_KEY = "sthlm-pulse:theme";
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
// Bump the version when the defaults change, so earlier saved choices don't hide them.
const LINES_STORAGE_KEY = "sthlm-pulse:lines:v2";
const SIDEBAR_STORAGE_KEY = "sthlm-pulse:sidebar";
const STATIONS_STORAGE_KEY = "sthlm-pulse:stations";
const PLAYER_STORAGE_KEY = "sthlm-pulse:player";
const WARNINGS_STORAGE_KEY = "sthlm-pulse:warnings";
const OTHER_LINES_STORAGE_KEY = "sthlm-pulse:other-lines";

// Must match --sidebar-w and the breakpoint in style.css.
const SIDEBAR_WIDTH = 300;
const smallScreen = window.matchMedia("(max-width: 640px)");

const NO_DEPTH = { depthCompare: "always" } as const;

// Additive blending for the neon theme: overlapping trails and halos glow.
const GLOW = {
  depthCompare: "always",
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

interface Line {
  path: [number, number][];
  colorKey: ColorKey;
  mode: Mode;
}

interface Dot {
  id: number;
  position: [number, number];
  colorKey: ColorKey;
  mode: Mode;
}

interface StationDot {
  id: number;
  position: [number, number];
  name: string;
  modes: number;
  /** Served by anything other than buses. */
  major: boolean;
}

// Stations appear once you've zoomed in, so the overview stays clean: rail,
// metro, tram and ferry first, then bus stops, which are far more numerous.
const STATION_ZOOM = 13;
const BUS_STOP_ZOOM = 14;
const LABEL_ZOOM = 13;
const BUS_LABEL_ZOOM = 16;

const state = {
  network: null as Network | null,
  lines: [] as Line[],
  trips: new Map<number, AnimatedTrip>(),
  visibleTrips: [] as AnimatedTrip[],
  enabled: new Set<Mode>(MODE_ORDER),
  /** Modes whose route lines are drawn (set in the settings panel). */
  lineModes: loadLineModes(),
  themeChoice: loadThemeChoice(),
  /** The theme in use: the choice, with "system" resolved to dark or light. */
  theme: resolveTheme(loadThemeChoice()),
  /** Base map style currently loaded, so switching between themes that share one skips a reload. */
  mapStyle: "",
  /** Map layer that our layers are drawn under, so place names stay on top. */
  beforeId: undefined as string | undefined,
  /** Following the real clock. False after picking a time or fast-forwarding. */
  live: true,
  speed: 1,
  /** Time stands still; play resumes at the same speed. */
  paused: false,
  simTime: 0,
  /** When live: simTime = liveOffset + performance.now() / 1000. */
  liveOffset: 0,
  loadedUntil: null as number | null,
  fetching: false,
  /** After a failed fetch, wait until this time (performance.now) before retrying. */
  retryAt: 0,
  retryDelayMs: 1000,
  /** Bumped on every time jump so responses for an old window are dropped. */
  epoch: 0,
  scrubbing: false,
  /** Clicked vehicle; details arrive from the server shortly after. */
  selected: null as { id: number; details: TripDetails | null } | null,
  /** Camera follows the selected vehicle. */
  following: false,
  /** Realtime: seconds late per trip id, and canceled trips. Empty without realtime. */
  delays: new Map<number, number>(),
  canceled: new Set<number>(),
  /** Bumped when delays shift trips, so deck.gl re-reads their timestamps. */
  delayVersion: 0,
  /** Latest delays response, for the realtime figures in "Idag i siffror". */
  realtime: null as Delays | null,
  /** Active disruptions, acute first. */
  alerts: [] as Alert[],
  /** Bumped when alerts change, so the warning icons are rebuilt. */
  alertsVersion: 0,
  /** Alert descriptions opened in the info card, by header. */
  expandedAlerts: new Set<string>(),
  /** Station markers and names on the map. */
  showStations: loadFlag(STATIONS_STORAGE_KEY),
  /** Warning icons at stations with disruptions. */
  showWarnings: loadFlag(WARNINGS_STORAGE_KEY),
  /** Clicked station; only one of selected, station and liveSelected is set at a time. */
  station: null as { id: number; details: StationDetails | null } | null,
  /** Regional and long-distance trains (GPS, live mode only) switched on. */
  showRegional: true,
  /** Large ships (AIS, live mode only). */
  showShips: true,
  /** Clicked GPS vehicle, by its live id. */
  liveSelected: null as string | null,
  /** Trafikverket's road ferries for the day, and their routes. */
  ferries: [] as FerryTrip[],
  ferryRoutes: [] as [number, number][][],
  showFerries: true,
  /** Route lines under "Övrig trafik": the railways regional trains use, and the ferry routes. */
  otherLines: loadOtherLines(),
  /** Main railway lines in the region, loaded the first time they're shown. */
  railLines: [] as [number, number][][],
  /** Clicked ferry crossing, by its index in `ferries`. */
  ferrySelected: null as number | null,
};

let map: MapLibreMap | null = null;

// --- Theme -----------------------------------------------------------------

function loadThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_ORDER.find((t) => t === saved) ?? "system";
  } catch {
    return "system";
  }
}

function resolveTheme(choice: ThemeChoice): Theme {
  if (choice !== "system") return choice;
  return prefersDark.matches ? "dark" : "light";
}

function loadLineModes(): Set<Mode> {
  const defaults = MODE_ORDER.filter((m) => MODES[m].linesByDefault);
  try {
    const saved = JSON.parse(localStorage.getItem(LINES_STORAGE_KEY) ?? "null");
    if (Array.isArray(saved)) return new Set(MODE_ORDER.filter((m) => saved.includes(m)));
  } catch {
    // Fall through to defaults.
  }
  return new Set(defaults);
}

/** On/off map options, on unless switched off. */
function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

function loadOtherLines(): { regional: boolean; ferries: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(OTHER_LINES_STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object") return { regional: saved.regional !== false, ferries: saved.ferries !== false };
  } catch {
    // Fall through to defaults.
  }
  return { regional: true, ferries: true };
}

function saveOtherLines(): void {
  try {
    localStorage.setItem(OTHER_LINES_STORAGE_KEY, JSON.stringify(state.otherLines));
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

/**
 * The main railway lines regional and long-distance trains run on, from
 * OpenStreetMap (© OpenStreetMap contributors, ODbL), simplified. Lines only
 * SL uses are left out, since SL's own lines are drawn already.
 */
async function loadRailLines(): Promise<void> {
  if (state.railLines.length) return;
  const { default: flat } = await import("./data/regional-rail.json");
  state.railLines = (flat as number[][]).map((line) => {
    const path: [number, number][] = [];
    for (let i = 0; i < line.length; i += 2) path.push([line[i]!, line[i + 1]!]);
    return path;
  });
}

function saveLineModes(): void {
  try {
    localStorage.setItem(LINES_STORAGE_KEY, JSON.stringify([...state.lineModes]));
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

function saveTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage can be unavailable (private mode); the theme just won't persist.
  }
}

/**
 * Tones down the base map so transit is what stands out: roads are faded, and
 * street names, house numbers, POIs and the map's own railway lines (which
 * would duplicate ours) are hidden.
 */
function quietBaseMap(map: MapLibreMap, theme: Theme): void {
  for (const layer of map.getStyle().layers) {
    const id = layer.id;
    if (/^(roadname_|housenumber|poi_|place_hamlet)/.test(id) || /(^|_)rail(_dash)?$/.test(id)) {
      map.setLayoutProperty(id, "visibility", "none");
    } else if (layer.type === "line" && /^(road|tunnel|bridge)_/.test(id)) {
      map.setPaintProperty(id, "line-opacity", THEMES[theme].roadOpacity);
    }
  }
  // Water labels and place names come after roads and buildings in both styles.
  state.beforeId = map.getStyle().layers.find((l) => l.id.startsWith("watername_"))?.id;
  addBuildings(map, theme);
}

const BUILDINGS_LAYER = "buildings-3d";

/**
 * Replaces the style's flat buildings with extruded ones that rise as you zoom
 * in. Transit layers are drawn after them without depth testing, so vehicles
 * stay visible behind buildings.
 */
function addBuildings(map: MapLibreMap, theme: Theme): void {
  const { buildingColor, buildingOpacity } = THEMES[theme];
  if (map.getLayer(BUILDINGS_LAYER)) {
    map.setPaintProperty(BUILDINGS_LAYER, "fill-extrusion-color", buildingColor);
    map.setPaintProperty(BUILDINGS_LAYER, "fill-extrusion-opacity", buildingOpacity);
    return;
  }
  const flat = map.getStyle().layers.find((l) => l.id === "building");
  if (!flat || flat.type !== "fill") return;
  for (const id of ["building", "building-top"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }
  // Buildings without height data get a typical inner-city height.
  const height: ExpressionSpecification = ["coalesce", ["get", "height"], 12];
  const base: ExpressionSpecification = ["coalesce", ["get", "min_height"], 0];
  map.addLayer(
    {
      id: BUILDINGS_LAYER,
      type: "fill-extrusion",
      source: flat.source,
      "source-layer": flat["source-layer"]!,
      filter: flat.filter,
      minzoom: 13,
      paint: {
        "fill-extrusion-color": buildingColor,
        "fill-extrusion-opacity": buildingOpacity,
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 15, height],
        "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 13, 0, 15, base],
        "fill-extrusion-vertical-gradient": true,
      },
    },
    state.beforeId,
  );
}

function applyTheme(map: MapLibreMap | null): void {
  document.documentElement.dataset.theme = state.theme;
  for (const b of els.themeButtons) {
    b.classList.toggle("is-active", b.dataset.themeOption === state.themeChoice);
  }
  paintSwatches();

  const style = THEMES[state.theme].mapStyle;
  if (map && style !== state.mapStyle) {
    map.setStyle(style);
    map.once("style.load", () => quietBaseMap(map, state.theme));
  } else if (map) {
    quietBaseMap(map, state.theme);
  }
  state.mapStyle = style;
}

// --- Time ------------------------------------------------------------------

const stockholmFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Stockholm",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

/** Days since 1970 for a YYYYMMDD service date. */
function dayNumber(serviceDate: string): number {
  return Math.round(Date.UTC(
    Number(serviceDate.slice(0, 4)),
    Number(serviceDate.slice(4, 6)) - 1,
    Number(serviceDate.slice(6, 8)),
  ) / 86_400_000);
}

/** Real Stockholm time as seconds since midnight of the network's service date. */
function realServiceTime(serviceDate: string): number {
  const now = new Date();
  const p = Object.fromEntries(stockholmFormat.formatToParts(now).map((x) => [x.type, x.value]));
  const today = dayNumber(`${p.year}${p.month}${p.day}`);
  const dayOffset = (today - dayNumber(serviceDate)) * 86_400;
  return dayOffset + Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) +
    now.getMilliseconds() / 1000;
}

function goLive(): void {
  if (!state.network) return;
  state.live = true;
  state.speed = 1;
  state.paused = false;
  state.liveOffset = realServiceTime(state.network.serviceDate) - performance.now() / 1000;
  state.simTime = state.liveOffset + performance.now() / 1000;
  resetTrips();
  updateControls();
  void refreshLive();
}

/** Jumps to a time of day (seconds since midnight) and leaves live mode. */
function jumpTo(t: number): void {
  state.live = false;
  state.simTime = t;
  resetTrips();
  updateControls();
}

/**
 * Starts loading trips from the current time again. Already loaded trips are
 * kept (so small scrubs don't flicker) and evictFinishedTrips() drops the rest.
 */
function resetTrips(): void {
  state.epoch++;
  state.loadedUntil = null;
  evictFinishedTrips();
}

/**
 * Trail length in simulated seconds. Short, so trails only hint at direction;
 * longer when fast-forwarding so they stay visible.
 */
function trailLength(): number {
  // Neon trails are the point of that theme, so they're kept longer.
  return THEMES[state.theme].glow
    ? 120 * state.speed ** 0.35
    : 60 * state.speed ** 0.45;
}

// --- Data ------------------------------------------------------------------

function useNetwork(network: Network): void {
  state.network = network;
  state.lines = buildLines(network);
  stationDots = network.stations.map((s, id) => ({
    id,
    position: [s.lon, s.lat],
    name: s.name,
    modes: s.modes,
    major: (s.modes & ~MODE_BITS.bus) !== 0,
  }));
  stationCache.key = "";
  drawActivity(network.activity);
}

/**
 * The server has moved on to a new service day, so trip ids and shape indexes
 * from the old network no longer match. Load the new network and start over,
 * keeping the same wall-clock time.
 */
async function switchNetwork(): Promise<void> {
  const old = state.network!;
  const network = await fetchNetwork();
  const dayShift = (dayNumber(network.serviceDate) - dayNumber(old.serviceDate)) * 86_400;
  useNetwork(network);
  state.trips.clear();
  state.delays.clear();
  state.canceled.clear();
  state.realtime = null;
  void refreshDelays();
  void refreshAlerts();
  void refreshFerries();
  void selectTrip(null);
  if (state.live) {
    goLive();
  } else {
    state.simTime -= dayShift;
    resetTrips();
  }
}

async function ensureTrips(): Promise<void> {
  const network = state.network;
  if (!network || state.fetching || performance.now() < state.retryAt) return;

  if (state.loadedUntil !== null && state.simTime + lookahead() < state.loadedUntil) return;

  const from = state.loadedUntil ?? state.simTime - DELAY_LOOKBACK_S;
  const to = from + CHUNK_S;
  const epoch = state.epoch;
  state.fetching = true;
  try {
    const { serviceDate, trips } = await fetchTrips(from, to);
    state.retryDelayMs = 1000;
    if (serviceDate !== network.serviceDate) {
      await switchNetwork();
      return;
    }
    if (epoch !== state.epoch) return; // the user jumped elsewhere meanwhile
    for (const trip of trips) {
      if (state.trips.has(trip.id)) continue;
      const animated = buildAnimatedTrip(trip, network);
      if (!animated) continue;
      applyDelay(animated, state.delays.get(trip.id) ?? 0);
      state.trips.set(trip.id, animated);
    }
    state.loadedUntil = to;
    refreshVisibleTrips();
    hideLoading();
  } catch (err) {
    // Back off (1 s, 2 s, 4 s ... up to 30 s) instead of retrying every frame.
    console.error(err);
    state.retryAt = performance.now() + state.retryDelayMs;
    state.retryDelayMs = Math.min(state.retryDelayMs * 2, 30_000);
  } finally {
    state.fetching = false;
  }
}

/** How far ahead of the current time trips are loaded: 10 real seconds of playback. */
function lookahead(): number {
  return Math.max(MIN_LOOKAHEAD_S, state.speed * 10);
}

/** Drops trips that have ended, or that start far ahead after a jump back in time. */
function evictFinishedTrips(): void {
  const cutoff = state.simTime - trailLength();
  // Keep everything that was loaded ahead; at high speeds that is more than an hour.
  const horizon = state.simTime + lookahead() + 2 * CHUNK_S;
  let removed = false;
  for (const [id, trip] of state.trips) {
    if (trip.end < cutoff || trip.start > horizon) {
      state.trips.delete(id);
      removed = true;
    }
  }
  if (removed) refreshVisibleTrips();
}

/** Fetches realtime delays and shifts the loaded trips to match. */
async function refreshDelays(): Promise<void> {
  try {
    const rt = await fetchDelays();
    // A new day is picked up by ensureTrips(); these ids belong to the other network.
    if (rt.serviceDate !== state.network?.serviceDate) return;
    state.delays.clear();
    for (let i = 0; i < rt.delays.length; i += 2) state.delays.set(rt.delays[i]!, rt.delays[i + 1]!);
    state.canceled = new Set(rt.canceled);
    state.realtime = rt;
    renderStats();
    for (const trip of state.trips.values()) applyDelay(trip, state.delays.get(trip.id) ?? 0);
    state.delayVersion++;
    refreshVisibleTrips();
  } catch (err) {
    console.error(err);
  }
}

async function refreshAlerts(): Promise<void> {
  try {
    const { serviceDate, alerts } = await fetchAlerts();
    if (serviceDate !== state.network?.serviceDate) return;
    state.alerts = alerts;
    state.alertsVersion++;
  } catch (err) {
    console.error(err);
  }
}

/** Loads the day's ferry crossings; they follow a timetable, like SL's trips. */
async function refreshFerries(): Promise<void> {
  try {
    const ferries = await fetchFerries();
    if (ferries.serviceDate !== state.network?.serviceDate) return;
    state.ferries = buildFerryTrips(ferries);
    state.ferryRoutes = ferries.routes.map((r) => r.path);
    state.ferrySelected = null;
  } catch (err) {
    console.error(err);
  }
}

/** Ferries on the water at the current time. */
function ferryDots(): FerryTrip[] {
  if (!state.showFerries) return [];
  return state.ferries.filter((f) => f.start <= state.simTime && state.simTime <= f.end);
}

/** Fetches GPS vehicles; they're only shown live, so nothing is fetched otherwise. */
async function refreshLive(): Promise<void> {
  if (!state.live || !(state.showRegional || state.showShips) || document.hidden) return;
  try {
    updateTracks(await fetchLive());
    liveVersion++;
  } catch (err) {
    console.error(err);
  }
}

/** Bumped when new GPS fixes arrive, so trails are rebuilt. */
let liveVersion = 0;

/** GPS vehicles drawn right now: only in live mode, and only when switched on. */
function liveShown(): LiveTrack[] {
  if (!state.live) return [];
  return [...tracks.values()].filter((t) => liveKindShown(t.vehicle.kind));
}

function liveKindShown(kind: LiveTrack["vehicle"]["kind"]): boolean {
  return kind === "ship" ? state.showShips : state.showRegional;
}

/** Ships are drawn larger, as the big vessels they are. */
const LIVE_STYLE = {
  train: { colorKey: "regional", radius: MODES.rail.dotRadius, trailWidth: MODES.rail.trailWidth },
  ship: { colorKey: "ship", radius: 4.6, trailWidth: 3 },
} as const;

function liveCount(kind: LiveTrack["vehicle"]["kind"]): number {
  let n = 0;
  for (const t of tracks.values()) if (t.vehicle.kind === kind) n++;
  return n;
}

function renderStats(): void {
  if (!state.network) return;
  els.stats.innerHTML = statsHtml(state.network.stats, state.network.routes, state.realtime);
}

function refreshVisibleTrips(): void {
  state.visibleTrips = [...state.trips.values()]
    .filter((t) => state.enabled.has(t.mode) && !state.canceled.has(t.id))
    .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode));
}

function buildLines(network: Network): Line[] {
  return network.shapes
    .map((shape) => {
      const route = network.routes[shape.route]!;
      const path: [number, number][] = [];
      for (let i = 0; i < shape.coords.length; i += 2) {
        path.push([shape.coords[i]!, shape.coords[i + 1]!]);
      }
      return { path, colorKey: colorKey(route), mode: route.mode };
    })
    .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode));
}

// --- Rendering -------------------------------------------------------------

/** Realtime lookups for the station card and the vehicles bound for a station. */
const realtime: Realtime = {
  delay: (trip) => state.delays.get(trip),
  canceled: (trip) => state.canceled.has(trip),
};

let stationDots: StationDot[] = [];
const stationCache = { key: "", stations: [] as StationDot[], labels: [] as StationDot[] };

/** Whether a station is drawn at this zoom, given the modes switched on. */
function stationFilter(zoom: number): { key: string; shown: (s: StationDot) => boolean } {
  const mask = [...state.enabled].reduce((m, mode) => m | MODE_BITS[mode], 0);
  const busStops = zoom >= BUS_STOP_ZOOM && (mask & MODE_BITS.bus) !== 0;
  return {
    key: `${mask}|${busStops}|${stationDots.length}`,
    shown: (s) =>
      (s.modes & mask & ~MODE_BITS.bus) !== 0 || (busStops && (s.modes & MODE_BITS.bus) !== 0),
  };
}

/**
 * Stations to draw at this zoom, for the modes switched on. Memoized, since
 * new arrays every frame would make deck.gl rebuild the layers.
 */
function visibleStations(zoom: number): { stations: StationDot[]; labels: StationDot[] } {
  if (!state.showStations || zoom < STATION_ZOOM) return { stations: [], labels: [] };
  const { key: filterKey, shown } = stationFilter(zoom);
  const labels = zoom >= BUS_LABEL_ZOOM ? 2 : zoom >= LABEL_ZOOM ? 1 : 0;
  const key = `${filterKey}|${labels}`;
  if (key !== stationCache.key) {
    stationCache.stations = stationDots.filter(shown);
    stationCache.labels = stationCache.stations.filter((s) => labels === 2 || (labels === 1 && s.major));
    stationCache.key = key;
  }
  return stationCache;
}

interface WarningDot extends StationDot {
  /** At least one of the station's alerts is acute (a triangle, not an info icon). */
  acute: boolean;
}

const warningCache = { key: "", warnings: [] as WarningDot[] };

/**
 * Warning icons for stations with disruptions, shown at the same zoom as the
 * stations themselves (even with station markers switched off).
 */
function visibleWarnings(zoom: number): WarningDot[] {
  if (!state.showWarnings || zoom < STATION_ZOOM) return [];
  const { key: filterKey, shown } = stationFilter(zoom);
  const key = `${filterKey}|${state.alertsVersion}`;
  if (key !== warningCache.key) {
    const acute = new Map<number, boolean>();
    for (const alert of state.alerts) {
      for (const s of alert.stations) acute.set(s, (acute.get(s) ?? false) || alert.acute);
    }
    warningCache.warnings = [...acute]
      .map(([id, isAcute]) => ({ ...stationDots[id]!, acute: isAcute }))
      .filter((s) => s.position && shown(s));
    warningCache.key = key;
  }
  return warningCache.warnings;
}

const hex = ([r, g, b]: number[]) => `#${[r, g, b].map((c) => c!.toString(16).padStart(2, "0")).join("")}`;

/** Warning triangle (acute) or info circle, as an SVG data URL in the theme's colors. */
function warningIcon(theme: Theme, acute: boolean) {
  const { warning, stationRing, stationFill } = THEMES[theme];
  const bg = hex(stationFill);
  const shape = acute
    ? `<path d="M12 2.5 22.5 20.5H1.5Z" fill="${hex(warning)}" stroke="${bg}" stroke-width="1.6" stroke-linejoin="round"/>
       <path d="M12 9v5" stroke="${bg}" stroke-width="2.2" stroke-linecap="round"/>
       <circle cx="12" cy="17.1" r="1.3" fill="${bg}"/>`
    : `<circle cx="12" cy="12" r="9.5" fill="${hex(stationRing)}" stroke="${bg}" stroke-width="1.6"/>
       <path d="M12 11v5.5" stroke="${bg}" stroke-width="2.2" stroke-linecap="round"/>
       <circle cx="12" cy="7.6" r="1.3" fill="${bg}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24">${shape}</svg>`;
  return {
    id: `${acute ? "warning" : "info"}-${theme}`,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: 64,
    height: 64,
  };
}

/**
 * Size multipliers by zoom level. Lines thin out when zoomed out so the
 * network doesn't turn into a blob, and dots grow when zoomed in so single
 * vehicles are easy to follow. Applied as layer-wide scales, so no per-vehicle
 * attributes need recomputing when zooming.
 */
function zoomScales(zoom: number): { line: number; dot: number } {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  return {
    line: clamp(2 ** ((zoom - 12) * 0.6), 0.35, 1.8),
    dot: clamp(2 ** ((zoom - 12) * 0.55), 0.45, 3),
  };
}

function buildLayers(dots: Dot[], ferries: FerryTrip[], zoom: number) {
  const scale = zoomScales(zoom);
  const theme = state.theme;
  const settings = THEMES[theme];
  // beforeId is read by MapboxOverlay in interleaved mode but isn't in the
  // layer prop types, so it's passed through a spread.
  const under = { beforeId: state.beforeId };
  const lines = state.lines.filter((l) => state.enabled.has(l.mode) && state.lineModes.has(l.mode));
  const selected = state.selected ? state.trips.get(state.selected.id) : undefined;
  const selectedFerry = state.ferrySelected !== null ? state.ferries[state.ferrySelected] : undefined;
  const selectedPosition = selected
    ? positionAt(selected, state.simTime)
    : state.liveSelected
      ? tracks.get(state.liveSelected)?.position ?? null
      : selectedFerry ? positionAt(selectedFerry, state.simTime) : null;
  const live = liveShown();
  const ringColor: [number, number, number] = theme === "light" ? [28, 31, 38] : [255, 255, 255];
  const { stations, labels } = visibleStations(zoom);
  const warnings = visibleWarnings(zoom);
  const station = state.station ? stationDots[state.station.id] : undefined;
  // Vehicles about to depart from the clicked station.
  const bound = state.station?.details
    ? new Set(upcomingTrips(state.station.details, state.simTime, realtime))
    : null;
  const boundDots = bound ? dots.filter((d) => bound.has(d.id)) : [];
  return [
    // Under SL's lines, which share some of the same tracks.
    new PathLayer<[number, number][]>({
      id: "rail-lines",
      ...under,
      data: state.showRegional && state.otherLines.regional ? state.railLines : [],
      getPath: (d) => d,
      getColor: [...color(theme, "regional"), MODES.rail.lineAlpha],
      getWidth: MODES.rail.lineWidth,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 0.5,
      jointRounded: true,
      capRounded: true,
      parameters: NO_DEPTH,
      updateTriggers: { getColor: theme },
    }),
    new PathLayer<Line>({
      id: "lines",
      ...under,
      data: lines,
      getPath: (d) => d.path,
      getColor: (d) => [...color(theme, d.colorKey), MODES[d.mode].lineAlpha],
      getWidth: (d) => MODES[d.mode].lineWidth,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 0.5,
      jointRounded: true,
      capRounded: true,
      parameters: NO_DEPTH,
      updateTriggers: { getColor: [theme, lines.length] },
    }),
    // The clicked vehicle's whole route, so you can see where it's heading.
    new PathLayer<AnimatedTrip>({
      id: "selected-route",
      ...under,
      data: selected ? [selected] : [],
      getPath: (d) => d.path,
      getColor: (d) => [...color(theme, d.colorKey), 210],
      getWidth: 3,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 2,
      jointRounded: true,
      capRounded: true,
      parameters: NO_DEPTH,
      updateTriggers: { getColor: theme },
    }),
    new TripsLayer<AnimatedTrip>({
      id: "trails",
      ...under,
      data: state.visibleTrips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: (d) => [
        ...color(theme, d.colorKey),
        Math.min(255, MODES[d.mode].trailAlpha * settings.trailAlphaScale),
      ],
      getWidth: (d) => MODES[d.mode].trailWidth,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      fadeTrail: true,
      trailLength: trailLength(),
      currentTime: state.simTime,
      parameters: settings.glow ? GLOW : NO_DEPTH,
      updateTriggers: { getColor: theme, getTimestamps: state.delayVersion },
    }),
    new ScatterplotLayer<StationDot>({
      id: "stations",
      ...under,
      data: stations,
      getPosition: (d) => d.position,
      getRadius: (d) => (d.major ? 3.4 : 2.4),
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      radiusMinPixels: 2,
      getFillColor: settings.stationFill,
      stroked: true,
      getLineColor: settings.stationRing,
      getLineWidth: (d) => (d.major ? 1.5 : 1),
      lineWidthUnits: "pixels",
      lineWidthMinPixels: 1,
      pickable: true,
      parameters: NO_DEPTH,
      updateTriggers: { getFillColor: theme, getLineColor: theme },
    }),
    new TextLayer<StationDot>({
      id: "station-labels",
      ...under,
      data: labels,
      getPosition: (d) => d.position,
      getText: (d) => d.name,
      getSize: (d) => (d.major ? 12 : 10.5),
      getColor: settings.labelColor,
      getPixelOffset: [0, -13],
      fontFamily: "Barlow, system-ui, sans-serif",
      fontWeight: 500,
      characterSet: "auto",
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: settings.stationFill,
      parameters: NO_DEPTH,
      updateTriggers: { getColor: theme },
    }),
    new ScatterplotLayer<Dot>({
      id: "halos",
      ...under,
      visible: settings.glow,
      data: dots,
      getPosition: (d) => d.position,
      getFillColor: (d) => [...color(theme, d.colorKey), 40],
      getRadius: (d) => MODES[d.mode].dotRadius * 2,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      parameters: GLOW,
    }),
    new ScatterplotLayer<Dot>({
      id: "dots",
      ...under,
      data: dots,
      getPosition: (d) => d.position,
      getFillColor: (d) => color(theme, d.colorKey),
      getRadius: (d) => MODES[d.mode].dotRadius,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      // A light ring lifts rail vehicles off their own line; buses stay plain.
      // Neon uses halos instead.
      stroked: settings.dotRing !== null,
      getLineColor: settings.dotRing ?? [0, 0, 0, 0],
      getLineWidth: (d) => (MODES[d.mode].dotRing ? 1.5 : 0),
      lineWidthUnits: "pixels",
      lineWidthScale: Math.min(1, scale.dot),
      pickable: true,
      parameters: NO_DEPTH,
    }),
    new PathLayer<[number, number][]>({
      id: "ferry-routes",
      ...under,
      data: state.showFerries && state.otherLines.ferries ? state.ferryRoutes : [],
      getPath: (d) => d,
      getColor: [...color(theme, "roadFerry"), MODES.ferry.lineAlpha + 40],
      getWidth: MODES.ferry.lineWidth,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 0.5,
      capRounded: true,
      jointRounded: true,
      parameters: NO_DEPTH,
      updateTriggers: { getColor: theme },
    }),
    new TripsLayer<FerryTrip>({
      id: "ferry-trails",
      ...under,
      data: ferries,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: [...color(theme, "roadFerry"), Math.min(255, MODES.ferry.trailAlpha * settings.trailAlphaScale)],
      getWidth: MODES.ferry.trailWidth,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      fadeTrail: true,
      trailLength: trailLength(),
      currentTime: state.simTime,
      parameters: settings.glow ? GLOW : NO_DEPTH,
      updateTriggers: { getColor: theme },
    }),
    new ScatterplotLayer<FerryTrip>({
      id: "ferry-halos",
      ...under,
      visible: settings.glow,
      data: ferries,
      getPosition: (d) => positionAt(d, state.simTime) ?? [0, 0],
      getFillColor: [...color(theme, "roadFerry"), 40],
      getRadius: MODES.ferry.dotRadius * 2,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      parameters: GLOW,
      updateTriggers: { getPosition: state.simTime },
    }),
    new ScatterplotLayer<FerryTrip>({
      id: "ferry-dots",
      ...under,
      data: ferries,
      getPosition: (d) => positionAt(d, state.simTime) ?? [0, 0],
      getFillColor: color(theme, "roadFerry"),
      getRadius: MODES.ferry.dotRadius,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      stroked: settings.dotRing !== null,
      getLineColor: settings.dotRing ?? [0, 0, 0, 0],
      getLineWidth: 1.5,
      lineWidthUnits: "pixels",
      lineWidthScale: Math.min(1, scale.dot),
      pickable: true,
      parameters: NO_DEPTH,
      updateTriggers: { getPosition: state.simTime, getFillColor: theme },
    }),
    new TripsLayer<LiveTrack>({
      id: "live-trails",
      ...under,
      data: live,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: (d) => [
        ...color(theme, LIVE_STYLE[d.vehicle.kind].colorKey),
        Math.min(255, MODES.rail.trailAlpha * settings.trailAlphaScale),
      ],
      getWidth: (d) => LIVE_STYLE[d.vehicle.kind].trailWidth,
      widthUnits: "pixels",
      widthScale: scale.line,
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      fadeTrail: true,
      trailLength: trailLength(),
      // GPS vehicles run on their own clock, a little behind real time (see live.ts).
      currentTime: liveTime(),
      // Paths grow with every new fix, so deck.gl re-reads them when fixes arrive.
      updateTriggers: { getPath: liveVersion, getTimestamps: liveVersion, getColor: theme },
      parameters: settings.glow ? GLOW : NO_DEPTH,
    }),
    new ScatterplotLayer<LiveTrack>({
      id: "live-halos",
      ...under,
      visible: settings.glow,
      data: live,
      getPosition: (d) => d.position,
      getFillColor: (d) => [...color(theme, LIVE_STYLE[d.vehicle.kind].colorKey), 40],
      getRadius: (d) => LIVE_STYLE[d.vehicle.kind].radius * 2,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      parameters: GLOW,
      updateTriggers: { getPosition: state.simTime, getFillColor: theme },
    }),
    new ScatterplotLayer<LiveTrack>({
      id: "live-dots",
      ...under,
      data: live,
      getPosition: (d) => d.position,
      getFillColor: (d) => color(theme, LIVE_STYLE[d.vehicle.kind].colorKey),
      getRadius: (d) => LIVE_STYLE[d.vehicle.kind].radius,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      stroked: settings.dotRing !== null,
      getLineColor: settings.dotRing ?? [0, 0, 0, 0],
      getLineWidth: 1.5,
      lineWidthUnits: "pixels",
      lineWidthScale: Math.min(1, scale.dot),
      pickable: true,
      parameters: NO_DEPTH,
      updateTriggers: { getPosition: state.simTime, getFillColor: theme },
    }),
    // Above the vehicles, so a disruption is never hidden under traffic.
    new IconLayer<WarningDot>({
      id: "warnings",
      ...under,
      data: warnings,
      getPosition: (d) => d.position,
      getIcon: (d) => warningIcon(theme, d.acute),
      getSize: (d) => (d.acute ? 15 : 12),
      sizeUnits: "pixels",
      // Up and to the right of the station, like a badge.
      getPixelOffset: [8, -8],
      // createImageBitmap can't decode SVG, so load the icons as plain images.
      loadOptions: { image: { type: "image" } },
      onIconError: (err) => console.error("Warning icon failed to load", err),
      pickable: true,
      parameters: NO_DEPTH,
      updateTriggers: { getIcon: theme },
    }),
    new ScatterplotLayer<{ position: [number, number]; mode: Mode }>({
      id: "selected-ring",
      ...under,
      data: selectedPosition ? [{ position: selectedPosition, mode: selected?.mode ?? "rail" }] : [],
      getPosition: (d) => d.position,
      getRadius: (d) => MODES[d.mode].dotRadius * 2,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      radiusMinPixels: 7,
      filled: false,
      stroked: true,
      getLineColor: ringColor,
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      parameters: NO_DEPTH,
    }),
    new ScatterplotLayer<StationDot>({
      id: "selected-station",
      ...under,
      data: station ? [station] : [],
      getPosition: (d) => d.position,
      getRadius: 8,
      radiusUnits: "pixels",
      filled: false,
      stroked: true,
      getLineColor: ringColor,
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      parameters: NO_DEPTH,
    }),
    new ScatterplotLayer<Dot>({
      id: "station-bound",
      ...under,
      data: boundDots,
      getPosition: (d) => d.position,
      getRadius: (d) => MODES[d.mode].dotRadius * 2,
      radiusUnits: "pixels",
      radiusScale: scale.dot,
      radiusMinPixels: 6,
      filled: false,
      stroked: true,
      getLineColor: [...ringColor, 170],
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      parameters: NO_DEPTH,
    }),
  ];
}

// --- UI --------------------------------------------------------------------

const els = {
  clock: document.getElementById("clock")!,
  total: document.getElementById("total")!,
  modes: document.getElementById("modes")!,
  otherModes: document.getElementById("other-modes")!,
  stats: document.getElementById("stats")!,
  mapOptions: document.getElementById("map-options")!,
  badge: document.getElementById("live-badge") as HTMLButtonElement,
  badgeLabel: document.querySelector<HTMLElement>("#live-badge span")!,
  themeOptions: document.getElementById("theme-options")!,
  sidebarToggle: document.getElementById("sidebar-toggle") as HTMLButtonElement,
  vehicle: document.getElementById("vehicle")!,
  themeButtons: [] as HTMLButtonElement[],
  slider: document.getElementById("time") as HTMLInputElement,
  activity: document.getElementById("activity")!,
  loading: document.getElementById("loading")!,
  speedButtons: [...document.querySelectorAll<HTMLButtonElement>("[data-speed]")],
  playToggle: document.getElementById("play-toggle") as HTMLButtonElement,
  playerHide: document.getElementById("player-hide") as HTMLButtonElement,
  playerShow: document.getElementById("player-show") as HTMLButtonElement,
  playerShowClock: document.getElementById("player-show-clock")!,
};

const countEls = new Map<Mode, HTMLElement>();
/** Line-color stripes in the mode tiles, repainted when the theme changes. */
const swatchEls: [Mode, HTMLElement][] = [];

// Toggle icons drawn like the map itself: a vehicle is a dot with its trail
// fading behind it, a line is a route with stop rings, metro-map style.
const VEHICLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M2.5 12h3.5" opacity="0.3" />
  <path d="M8.5 12h3" opacity="0.65" />
  <circle cx="17" cy="12" r="4" fill="currentColor" stroke="none" />
</svg>`;
const LINE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M2.5 19 6.6 14.9M10.6 13h2.8M17.4 11.1 21.5 7" />
  <circle cx="8.3" cy="13" r="2.4" />
  <circle cx="15.7" cy="13" r="2.4" />
</svg>`;

/** Mode rows in the sidebar, tinted with their mode's color when the theme changes. */
const modeRows = new Map<Mode, HTMLElement>();

const STATION_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="5" />
</svg>`;

const WARNING_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 4 21 19.5H3Z" stroke-linejoin="round" />
  <path d="M12 10v4" />
</svg>`;

interface MapOption {
  label: string;
  hint: string;
  /** Small marker before the label, as drawn on the map. */
  marker: string;
  icon: string;
  get(): boolean;
  set(on: boolean): void;
}

const MAP_OPTIONS: MapOption[] = [
  {
    label: "Hållplatser",
    hint: "Syns när du zoomar in",
    marker: `<span class="mode__icon" aria-hidden="true"></span>`,
    icon: STATION_ICON,
    get: () => state.showStations,
    set(on) {
      state.showStations = on;
      saveFlag(STATIONS_STORAGE_KEY, on);
      // A hidden station can't stay selected.
      if (!on && state.station) void selectTrip(null);
    },
  },
  {
    label: "Varningar",
    hint: "Störningar vid hållplatser",
    marker: `<span class="mode__icon mode__icon--warning" aria-hidden="true"></span>`,
    icon: WARNING_ICON,
    get: () => state.showWarnings,
    set(on) {
      state.showWarnings = on;
      saveFlag(WARNINGS_STORAGE_KEY, on);
    },
  },
];

/** Toggles for things on the map other than vehicles and lines. */
function buildMapOptions(): void {
  for (const option of MAP_OPTIONS) {
    const li = document.createElement("li");
    li.className = "mode mode--option";
    li.innerHTML = `
      ${option.marker}
      <span class="mode__text">
        <span class="mode__label">${option.label}</span>
        <span class="mode__count">${option.hint}</span>
      </span>
      <button type="button" class="chip" title="${option.label}" aria-label="Visa ${option.label.toLowerCase()}">${option.icon}</button>`;
    const button = li.querySelector("button")!;
    const render = () => {
      button.setAttribute("aria-pressed", String(option.get()));
      li.classList.toggle("is-off", !option.get());
    };
    button.addEventListener("click", () => {
      option.set(!option.get());
      render();
    });
    render();
    els.mapOptions.append(li);
  }
}

/** One row per mode, with toggles for its vehicles and its route lines. */
function buildModeList(): void {
  for (const mode of [...MODE_ORDER].reverse()) {
    const { label } = MODES[mode];
    const li = document.createElement("li");
    li.className = "mode";
    // The mode's pictogram over a stripe of its line colors.
    li.innerHTML = `
      <span class="mode__tile">${PICTOGRAMS[mode]}<span class="mode__swatches"></span></span>
      <span class="mode__text">
        <span class="mode__label">${label}</span>
        <span class="mode__count"><b>0</b> i trafik</span>
      </span>
      <button type="button" class="chip" title="Fordon" aria-label="Visa fordon: ${label}">${VEHICLE_ICON}</button>
      <button type="button" class="chip" title="Linjer" aria-label="Visa linjer: ${label}">${LINE_ICON}</button>`;
    const [vehicles, lines] = li.querySelectorAll("button");

    const render = () => {
      vehicles!.setAttribute("aria-pressed", String(state.enabled.has(mode)));
      lines!.setAttribute("aria-pressed", String(state.lineModes.has(mode)));
      li.classList.toggle("is-off", !state.enabled.has(mode));
    };
    vehicles!.addEventListener("click", () => {
      if (!state.enabled.delete(mode)) state.enabled.add(mode);
      refreshVisibleTrips();
      render();
    });
    lines!.addEventListener("click", () => {
      if (!state.lineModes.delete(mode)) state.lineModes.add(mode);
      saveLineModes();
      render();
    });
    render();

    countEls.set(mode, li.querySelector(".mode__count b")!);
    swatchEls.push([mode, li.querySelector(".mode__swatches")!]);
    modeRows.set(mode, li);
    els.modes.append(li);
  }
  for (const row of OTHER_ROWS) els.otherModes.append(buildOtherRow(row));
}

/** A row under "Övrig trafik", with toggles for its vehicles and its route lines. */
interface OtherRow {
  label: string;
  pictogram: string;
  colorKey: ColorKey;
  get(): boolean;
  set(on: boolean): void;
  /** Whether its route lines are drawn; ships have none. */
  lines?: { get(): boolean; set(on: boolean): void };
  /** Filled in by buildOtherRow. */
  row?: HTMLElement;
  count?: HTMLElement;
}

const OTHER_ROWS: OtherRow[] = [
  {
    label: "Regional- & fjärrtåg",
    pictogram: REGIONAL_PICTOGRAM,
    colorKey: "regional",
    get: () => state.showRegional,
    set(on) {
      state.showRegional = on;
      if (!on && state.liveSelected?.startsWith("train:")) void selectTrip(null);
      void refreshLive();
    },
    lines: {
      get: () => state.otherLines.regional,
      set(on) {
        state.otherLines.regional = on;
        if (on) void loadRailLines();
      },
    },
  },
  {
    label: "Vägfärjor",
    pictogram: ROAD_FERRY_PICTOGRAM,
    colorKey: "roadFerry",
    get: () => state.showFerries,
    set(on) {
      state.showFerries = on;
      if (!on && state.ferrySelected !== null) void selectTrip(null);
    },
    lines: {
      get: () => state.otherLines.ferries,
      set(on) {
        state.otherLines.ferries = on;
      },
    },
  },
  {
    label: "Fartyg",
    pictogram: SHIP_PICTOGRAM,
    colorKey: "ship",
    get: () => state.showShips,
    set(on) {
      state.showShips = on;
      if (!on && state.liveSelected?.startsWith("ship:")) void selectTrip(null);
      void refreshLive();
    },
  },
];
const [REGIONAL_ROW, FERRY_ROW, SHIP_ROW] = OTHER_ROWS as [OtherRow, OtherRow, OtherRow];

function buildOtherRow(spec: OtherRow): HTMLElement {
  const li = document.createElement("li");
  li.className = "mode";
  li.innerHTML = `
    <span class="mode__tile">${spec.pictogram}<span class="mode__swatches"><i></i></span></span>
    <span class="mode__text">
      <span class="mode__label">${escapeHtml(spec.label)}</span>
      <span class="mode__count"></span>
    </span>
    <button type="button" class="chip" title="Fordon" aria-label="Visa fordon: ${escapeHtml(spec.label)}">${VEHICLE_ICON}</button>
    ${spec.lines ? `<button type="button" class="chip" title="Linjer" aria-label="Visa linjer: ${escapeHtml(spec.label)}">${LINE_ICON}</button>` : ""}`;
  const [vehicles, lines] = li.querySelectorAll("button");
  const render = () => {
    vehicles!.setAttribute("aria-pressed", String(spec.get()));
    if (spec.lines) lines!.setAttribute("aria-pressed", String(spec.lines.get()));
    li.classList.toggle("is-off", !spec.get());
  };
  vehicles!.addEventListener("click", () => {
    spec.set(!spec.get());
    render();
  });
  lines?.addEventListener("click", () => {
    spec.lines!.set(!spec.lines!.get());
    saveOtherLines();
    render();
  });
  render();
  spec.row = li;
  spec.count = li.querySelector(".mode__count")!;
  return li;
}

function paintSwatches(): void {
  for (const [mode, el] of swatchEls) {
    el.innerHTML = MODES[mode].swatches
      .map((key) => `<i style="--c: rgb(${color(state.theme, key).join(",")})"></i>`)
      .join("");
  }
  for (const [mode, row] of modeRows) {
    row.style.setProperty("--c", `rgb(${color(state.theme, MODES[mode].swatches[0]!).join(",")})`);
  }
  for (const { row, colorKey: key } of OTHER_ROWS) {
    row?.style.setProperty("--c", `rgb(${color(state.theme, key).join(",")})`);
  }
}

function setupControls(getMap: () => MapLibreMap | null): void {
  for (const button of els.speedButtons) {
    button.addEventListener("click", () => {
      const speed = Number(button.dataset.speed);
      if (speed !== 1) state.live = false;
      state.speed = speed;
      state.paused = false;
      updateControls();
    });
  }

  els.badge.addEventListener("click", goLive);
  els.playToggle.addEventListener("click", togglePause);
  els.playerHide.addEventListener("click", () => setPlayerHidden(true));
  els.playerShow.addEventListener("click", () => setPlayerHidden(false));
  setPlayerHidden(document.documentElement.dataset.player === "hidden");
  window.addEventListener("keydown", (e) => {
    // Space pauses, unless it would press a focused button or move the slider.
    if (e.key !== " " || (e.target as Element).closest("button, input")) return;
    e.preventDefault();
    togglePause();
  });

  renderSidebar();
  els.sidebarToggle.addEventListener("click", () => setSidebarOpen(!sidebarOpen()));
  // On a small screen the sidebar is a drawer over the map, so start closed.
  smallScreen.addEventListener("change", () => {
    if (smallScreen.matches) setSidebarOpen(false);
    else padMap(false);
  });

  els.vehicle.addEventListener("click", (e) => {
    const target = e.target as Element;
    if (target.closest(".vehicle__close")) void selectTrip(null);
    const more = target.closest<HTMLElement>(".card-alert__more");
    if (more) {
      const header = more.dataset.alert!;
      if (!state.expandedAlerts.delete(header)) state.expandedAlerts.add(header);
      updateVehicleCard();
    }
    const departure = target.closest<HTMLElement>("button.departure");
    if (departure) void selectTrip(Number(departure.dataset.trip));
    if (target.closest(".vehicle__follow")) {
      if (state.following) stopFollowing();
      else startFollowing();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void selectTrip(null);
  });

  for (const choice of THEME_ORDER) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.themeOption = choice;
    button.textContent = THEME_LABELS[choice];
    button.addEventListener("click", () => {
      state.themeChoice = choice;
      state.theme = resolveTheme(choice);
      saveTheme(choice);
      applyTheme(getMap());
    });
    els.themeButtons.push(button);
    els.themeOptions.append(button);
  }
  // "System" follows the OS switching between light and dark, e.g. at sunset.
  prefersDark.addEventListener("change", () => {
    if (state.themeChoice !== "system") return;
    state.theme = resolveTheme("system");
    applyTheme(getMap());
  });

  // Scrubbing reloads trips for the new time; ensureTrips() keeps up while dragging.
  els.slider.addEventListener("input", () => jumpTo(Number(els.slider.value)));
  els.slider.addEventListener("pointerdown", () => (state.scrubbing = true));
  window.addEventListener("pointerup", () => (state.scrubbing = false));
}

/** Slides the time strip away, leaving a small chip with the time to bring it back. */
function setPlayerHidden(hidden: boolean): void {
  if (hidden) document.documentElement.dataset.player = "hidden";
  else delete document.documentElement.dataset.player;
  els.playerHide.setAttribute("aria-expanded", String(!hidden));
  els.playerShow.setAttribute("aria-expanded", String(!hidden));
  try {
    if (hidden) localStorage.setItem(PLAYER_STORAGE_KEY, "hidden");
    else localStorage.removeItem(PLAYER_STORAGE_KEY);
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

function togglePause(): void {
  // Pausing leaves live mode: the clock stops at the moment shown.
  state.live = false;
  state.paused = !state.paused;
  updateControls();
}

function updateControls(): void {
  for (const b of els.speedButtons) {
    b.classList.toggle("is-active", Number(b.dataset.speed) === state.speed);
  }
  els.playToggle.innerHTML = state.paused ? PLAY_ICON : PAUSE_ICON;
  els.playToggle.setAttribute("aria-label", state.paused ? "Spela" : "Pausa");
  els.playToggle.title = `${state.paused ? "Spela" : "Pausa"} (mellanslag)`;
  els.playToggle.classList.toggle("is-paused", state.paused);
  els.badge.disabled = state.live;
  els.badge.classList.toggle("is-paused", !state.live);
  els.badgeLabel.textContent = state.live ? "Live" : "Till nu";
}

// --- Sidebar ---------------------------------------------------------------

function sidebarOpen(): boolean {
  return document.documentElement.dataset.sidebar !== "collapsed";
}

function setSidebarOpen(open: boolean): void {
  document.documentElement.dataset.sidebar = open ? "open" : "collapsed";
  // Small screens always start closed, so only remember the desktop choice.
  if (!smallScreen.matches) {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? "open" : "collapsed");
    } catch {
      // Storage unavailable; the choice just won't persist.
    }
  }
  renderSidebar();
  padMap(true);
}

function renderSidebar(): void {
  const open = sidebarOpen();
  const label = open ? "Fäll in panelen" : "Fäll ut panelen";
  els.sidebarToggle.setAttribute("aria-expanded", String(open));
  els.sidebarToggle.setAttribute("aria-label", label);
  els.sidebarToggle.title = label;
}

/**
 * Pads the map by the sidebar's width so its center (and a followed vehicle)
 * sits in the visible part. Animated together with the sidebar, the map glides
 * along as it opens and closes.
 */
function padMap(animate: boolean): void {
  if (!map) return;
  const left = !smallScreen.matches && sidebarOpen() ? SIDEBAR_WIDTH : 0;
  if (animate) map.easeTo({ padding: { left }, duration: 300 });
  else map.setPadding({ top: 0, right: 0, bottom: 0, left });
}

/** Draws the day's activity profile behind the time slider. */
function drawActivity(activity: number[]): void {
  const max = Math.max(...activity, 1);
  const n = activity.length;
  const points = activity.map((v, i) => `${i},${32 - (v / max) * 30}`).join(" ");
  const area = `M0,32 L${points} L${n - 1},32 Z`;
  const svg = (cls: string) =>
    `<svg class="${cls}" viewBox="0 0 ${n - 1} 32" preserveAspectRatio="none"><path d="${area}"/></svg>`;
  els.activity.innerHTML = svg("timeline__area") + svg("timeline__area timeline__area--played");
}

function updatePanel(counts: Map<Mode, number>, ferries: number): void {
  els.clock.textContent = formatClock(state.simTime);
  els.playerShowClock.textContent = formatHm(state.simTime);
  const dayTime = Math.min(Math.max(state.simTime, 0), 86_399);
  if (!state.scrubbing) els.slider.value = String(dayTime);
  els.activity.style.setProperty("--progress", `${(dayTime / 86_400) * 100}%`);
  let total = 0;
  for (const mode of MODE_ORDER) {
    const n = counts.get(mode) ?? 0;
    total += n;
    countEls.get(mode)!.textContent = n.toLocaleString("sv-SE");
  }
  // GPS vehicles have no history, so outside live mode there's nothing to count.
  for (const [row, kind] of [[REGIONAL_ROW, "train"], [SHIP_ROW, "ship"]] as const) {
    if (state.live) {
      const n = liveCount(kind);
      total += n;
      row.count!.innerHTML = `<b>${n.toLocaleString("sv-SE")}</b> i trafik`;
    } else {
      row.count!.textContent = "Syns bara live";
    }
  }
  total += ferries;
  FERRY_ROW.count!.innerHTML = `<b>${ferries.toLocaleString("sv-SE")}</b> i trafik`;
  els.total.textContent = total.toLocaleString("sv-SE");
}

// --- Vehicle card ----------------------------------------------------------

/** Zoom used when starting to follow, unless the user is already closer. */
const FOLLOW_ZOOM = 14;

function startFollowing(): void {
  const trip = state.selected && state.trips.get(state.selected.id);
  const position = trip && positionAt(trip, state.simTime);
  if (!map || !position) return;
  state.following = true;
  // Zoom around the vehicle, not the mouse, so it stays centered.
  map.scrollZoom.enable({ around: "center" });
  map.easeTo({ center: position, zoom: Math.max(map.getZoom(), FOLLOW_ZOOM), duration: 800 });
  updateVehicleCard();
}

function stopFollowing(): void {
  if (!state.following) return;
  state.following = false;
  map?.scrollZoom.enable();
  updateVehicleCard();
}

/** Called every frame: keeps the followed vehicle in the middle of the map. */
function followSelected(): void {
  if (!state.following || !map) return;
  const trip = state.selected && state.trips.get(state.selected.id);
  const position = trip && positionAt(trip, state.simTime);
  if (!position) return;
  // Let the initial fly-in and zoom gestures finish before taking over again.
  if (map.isEasing() || map.isZooming() || map.isRotating()) return;
  map.jumpTo({ center: position });
}

async function selectTrip(id: number | null): Promise<void> {
  if (id !== state.selected?.id) stopFollowing();
  state.station = null;
  state.liveSelected = null;
  state.ferrySelected = null;
  if (id === null) {
    state.selected = null;
    updateVehicleCard();
    return;
  }
  if (state.selected?.id === id) return;
  state.selected = { id, details: null };
  updateVehicleCard();
  try {
    const details = await fetchTripDetails(id);
    // Ignore details from a different day's network (see switchNetwork).
    if (state.selected?.id === id && details.serviceDate === state.network?.serviceDate) {
      state.selected.details = details;
    }
  } catch (err) {
    console.error(err);
  }
  updateVehicleCard();
}

async function selectStation(id: number): Promise<void> {
  stopFollowing();
  state.selected = null;
  state.liveSelected = null;
  state.ferrySelected = null;
  if (state.station?.id === id) return;
  state.station = { id, details: null };
  updateVehicleCard();
  try {
    const details = await fetchStation(id);
    if (state.station?.id === id && details.serviceDate === state.network?.serviceDate) {
      state.station.details = details;
    }
  } catch (err) {
    console.error(err);
  }
  updateVehicleCard();
}

let lastCardHtml = "";

const CLOSE_BUTTON = `<button class="icon-button vehicle__close" type="button" aria-label="Stäng">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
  </button>`;

function showCard(html: string): void {
  if (html !== lastCardHtml) {
    els.vehicle.innerHTML = html;
    lastCardHtml = html;
  }
  els.vehicle.hidden = false;
}

function updateStationCard(): void {
  const { id, details } = state.station!;
  if (!details || !state.network) {
    showCard(`<header class="vehicle__header">
        <span class="station__icon" aria-hidden="true"></span>
        <div class="vehicle__title">
          <div class="vehicle__dest">${escapeHtml(stationDots[id]?.name ?? "")}</div>
          <div class="vehicle__mode">Laddar…</div>
        </div>
        ${CLOSE_BUTTON}
      </header>`);
    return;
  }
  showCard(stationCardHtml(
    details,
    state.network.routes,
    state.theme,
    state.simTime,
    CLOSE_BUTTON,
    (trip) => state.trips.has(trip),
    realtime,
    cardAlertsHtml(state.alerts.filter((a) => a.stations.includes(id)).slice(0, CARD_ALERTS_SHOWN), state.expandedAlerts),
  ));
}

function selectLive(id: string): void {
  stopFollowing();
  state.selected = null;
  state.station = null;
  state.ferrySelected = null;
  state.liveSelected = id;
  updateVehicleCard();
}

function selectFerry(id: number): void {
  stopFollowing();
  state.selected = null;
  state.station = null;
  state.liveSelected = null;
  state.ferrySelected = id;
  updateVehicleCard();
}

/** Renders the info card for the selected vehicle or station; cheap to call often. */
function updateVehicleCard(): void {
  if (state.station) {
    updateStationCard();
    return;
  }
  if (state.liveSelected) {
    const found = state.live ? tracks.get(state.liveSelected) : undefined;
    const track = found && liveKindShown(found.vehicle.kind) ? found : undefined;
    if (track) {
      const badge = badgeStyle(color(state.theme, LIVE_STYLE[track.vehicle.kind].colorKey));
      showCard(liveCardHtml(track.vehicle, badge, CLOSE_BUTTON));
      return;
    }
    // Gone from the feed, or live mode left.
    state.liveSelected = null;
  }
  if (state.ferrySelected !== null) {
    const trip = state.ferries[state.ferrySelected];
    if (trip && state.showFerries && trip.start <= state.simTime && state.simTime <= trip.end + 60) {
      showCard(ferryCardHtml(trip, badgeStyle(color(state.theme, "roadFerry")), CLOSE_BUTTON));
      return;
    }
    // The crossing is over.
    state.ferrySelected = null;
  }
  const selected = state.selected;
  const trip = selected ? state.trips.get(selected.id) : undefined;
  // Close the card once the trip has ended (or been dropped after a time jump).
  if (selected && (!trip || state.simTime > trip.end + 60)) {
    state.selected = null;
    stopFollowing();
  }

  if (!state.selected || !trip) {
    els.vehicle.hidden = true;
    lastCardHtml = "";
    return;
  }

  const details = state.selected.details;
  const rgb = color(state.theme, trip.colorKey).join(",");
  const badge = badgeStyle(color(state.theme, trip.colorKey));

  let html: string;
  if (!details) {
    html = `<header class="vehicle__header">
        <span class="vehicle__badge" style="${badge}"></span>
        <div class="vehicle__title"><div class="vehicle__mode">Laddar…</div></div>
        ${CLOSE_BUTTON}
      </header>`;
  } else {
    const { route, headsign, calls } = details;
    const desc = route.desc ? route.desc[0]!.toUpperCase() + route.desc.slice(1) : "";
    const modeLabel = desc || MODES[route.mode].label;
    const hasRealtime = state.delays.has(trip.id);
    // Calls are timetable times; compare them with the time the vehicle is "at".
    const t = state.simTime - trip.delay;
    const nextIndex = Math.max(0, calls.findIndex((c) => c.departure >= t));
    const next = calls[nextIndex]!;
    const atStop = next.arrival <= t;
    const minutes = Math.max(0, Math.round((next.arrival - t) / 60));
    const status = atStop
      ? `Vid <strong>${escapeHtml(next.name)}</strong>`
      : `Nästa <strong>${escapeHtml(next.name)}</strong>
         <span class="vehicle__eta">${minutes === 0 ? "nu" : `om ${minutes} min`}</span>`;
    const upcoming = calls
      .slice(nextIndex, nextIndex + 6)
      .map((c) => `<li><time>${formatHm(c.arrival + trip.delay)}</time><span>${escapeHtml(c.name)}</span></li>`)
      .join("");
    const remaining = calls.length - nextIndex - 6;
    const first = calls[0]!;
    const last = calls[calls.length - 1]!;

    html = `<header class="vehicle__header">
        <span class="vehicle__badge" style="${badge}">${escapeHtml(route.name)}</span>
        <div class="vehicle__title">
          <div class="vehicle__dest">mot ${escapeHtml(headsign)}</div>
          <div class="vehicle__mode">${escapeHtml(modeLabel)}${hasRealtime ? ` · ${delayBadge(trip.delay)}` : ""}</div>
        </div>
        ${CLOSE_BUTTON}
      </header>
      ${cardAlertsHtml(
        // The trip's own alerts, and acute ones for its line; planned changes such as
        // elevator work belong to the station card.
        state.alerts
          .filter((a) => a.trips.includes(trip.id) || (a.acute && a.routes.includes(trip.route)))
          .slice(0, CARD_ALERTS_SHOWN),
        state.expandedAlerts,
      )}
      <div class="vehicle__status">${status}</div>
      <button class="vehicle__follow${state.following ? " is-active" : ""}" type="button"
        aria-pressed="${state.following}">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
        ${state.following ? "Följer fordonet" : "Följ fordonet"}
      </button>
      <ol class="vehicle__stops" style="--c: rgb(${rgb})">${upcoming}</ol>
      ${remaining > 0 ? `<div class="vehicle__more">+ ${remaining} hållplatser till</div>` : ""}
      <footer class="vehicle__foot">
        ${escapeHtml(first.name)} ${formatHm(first.departure)} → ${escapeHtml(last.name)} ${formatHm(last.arrival)}
        enligt tidtabell${hasRealtime ? " · övriga tider i realtid" : ""}
      </footer>`;
  }

  showCard(html);
}

function hideLoading(): void {
  els.loading.classList.add("is-hidden");
}

// --- Main loop -------------------------------------------------------------

async function main(): Promise<void> {
  buildModeList();
  buildMapOptions();
  setupControls(() => map);
  applyTheme(null);

  map = new MapLibreMap({
    container: "map",
    style: THEMES[state.theme].mapStyle,
    center: [18.0686, 59.3293],
    zoom: window.innerWidth < 640 ? 10 : 11,
    pitch: 40,
    bearing: -12,
    maxPitch: 60,
    attributionControl: { compact: true },
  });
  const loadedMap = map;
  padMap(false);

  const [network] = await Promise.all([
    fetchNetwork(),
    new Promise<void>((resolve) => loadedMap.once("load", () => resolve())),
  ]);
  quietBaseMap(loadedMap, state.theme);
  state.mapStyle = THEMES[state.theme].mapStyle;
  useNetwork(network);
  renderStats();
  // Delays first, so the first trips are already shifted when they appear.
  await refreshDelays();
  void refreshAlerts();
  void refreshFerries();
  if (state.otherLines.regional) void loadRailLines();
  goLive();
  setInterval(() => {
    if (!document.hidden) void refreshDelays();
  }, DELAYS_POLL_MS);
  setInterval(() => {
    if (!document.hidden) void refreshAlerts();
  }, ALERTS_POLL_MS);
  setInterval(() => void refreshLive(), LIVE_POLL_MS);
  // Ferry departures change rarely (a canceled crossing); the server refreshes them every 30 min.
  setInterval(() => {
    if (!document.hidden) void refreshFerries();
  }, FERRIES_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void refreshDelays();
    void refreshAlerts();
    void refreshLive();
  });

  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: [],
    pickingRadius: 8,
    // Clicking a dot or station opens its card; clicking anywhere else closes it.
    onClick: (info) => {
      const layer = info.layer?.id;
      if (layer === "stations" || layer === "warnings") void selectStation((info.object as StationDot).id);
      else if (layer === "live-dots") selectLive((info.object as LiveTrack).vehicle.id);
      else if (layer === "ferry-dots") selectFerry((info.object as FerryTrip).id);
      else void selectTrip((info.object as Dot | undefined)?.id ?? null);
    },
    onHover: (info) => {
      loadedMap.getCanvas().style.cursor = info.object ? "pointer" : "";
    },
    getTooltip: ({ object, layer }) => {
      if (layer?.id !== "warnings" || !object) return null;
      const station = object as WarningDot;
      const alerts = state.alerts.filter((a) => a.stations.includes(station.id));
      // Styled by .map-tooltip; deck.gl's own tooltip box is made invisible.
      return {
        html: warningTooltipHtml(station.name, alerts),
        style: { background: "none", padding: "0", boxShadow: "none" },
      };
    },
  });
  loadedMap.addControl(overlay);
  // Dragging the map means the user wants to look elsewhere.
  loadedMap.on("dragstart", stopFollowing);

  let lastFrame = performance.now();
  let lastPanelUpdate = 0;
  let lastEviction = 0;

  const frame = (now: number) => {
    const dt = Math.min((now - lastFrame) / 1000, 0.25);
    lastFrame = now;
    state.simTime = state.live
      ? state.liveOffset + now / 1000
      : state.simTime + (state.paused ? 0 : dt * state.speed);

    void ensureTrips();
    if (now - lastEviction > 2000) {
      evictFinishedTrips();
      lastEviction = now;
    }

    const dots: Dot[] = [];
    const counts = new Map<Mode, number>();
    for (const trip of state.trips.values()) {
      const position = positionAt(trip, state.simTime);
      if (!position || state.canceled.has(trip.id)) continue;
      counts.set(trip.mode, (counts.get(trip.mode) ?? 0) + 1);
      if (state.enabled.has(trip.mode)) {
        dots.push({ id: trip.id, position, colorKey: trip.colorKey, mode: trip.mode });
      }
    }
    dots.sort((a, b) => MODES[a.mode].dotRadius - MODES[b.mode].dotRadius);

    if (state.live) advanceTracks();
    followSelected();
    const ferries = ferryDots();
    overlay.setProps({ layers: buildLayers(dots, ferries, loadedMap.getZoom()) });

    if (now - lastPanelUpdate > 250) {
      updatePanel(counts, ferries.length);
      updateVehicleCard();
      lastPanelUpdate = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Handy for poking at the app from the console or test scripts; dev builds only.
  if (import.meta.env.DEV) {
    Object.assign(window, { pulse: { map: loadedMap, selectStation, selectTrip, state } });
  }
}

main().catch((err) => {
  console.error(err);
  document.getElementById("loading")!.querySelector("span")!.textContent =
    "Kunde inte ladda trafikdata. Försök igen om en stund.";
});
