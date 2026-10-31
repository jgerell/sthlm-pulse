// Ships from AIS, streamed by AISStream over a websocket. Only large ships are
// kept: SL's own boats (Waxholmsbolaget) are 25-40 m and already drawn from the
// timetable, and AIS has no way to tell them apart, so a length limit leaves
// them out along with leisure craft, pilots and rescue boats. Trafikverket's
// road ferries are drawn from their timetable too, so ships of their size on
// a ferry route are left out as well.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { FERRY_ROUTES } from "../ferries/routes.js";
import type { LiveVehicle } from "./vehicles.js";

const URL = "wss://stream.aisstream.io/v0/stream";
const MIN_LENGTH_M = 50;
// Road ferries are up to about 100 m; the ships passing them are far larger.
const ROAD_FERRY_MAX_LENGTH_M = 110;
const ROAD_FERRY_DISTANCE_M = 300;
// Stockholm's archipelago, with the approaches to Nynäshamn and Kapellskär.
const AREA = [[58.7, 17.2], [60.1, 19.6]];
// Ships report every few seconds under way, but only every few minutes at anchor.
const MAX_AGE_S = 15 * 60;
// The stream is closed when nobody has asked for ships this long.
const IDLE_MS = 5 * 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const KNOT_KMH = 1.852;
// Static data (name, type, length) only comes every six minutes, so it's saved
// for the next start instead of waiting for it again.
const STATIC_PATH = join(config.dataDir, "ships.json");
const SAVE_MS = 5 * 60_000;

interface Ship {
  name: string;
  type: number;
  length: number;
  destination: string;
  lon?: number;
  lat?: number;
  /** Course over ground, degrees. */
  course?: number;
  /** Knots. */
  speed?: number;
  /** Unix seconds. */
  time?: number;
}

/** By MMSI. Kept across reconnects, since static data only comes every few minutes. */
const ships = new Map<number, Ship>();
let socket: WebSocket | null = null;
let askedAt = 0;
let retryMs = RETRY_MIN_MS;
let retryTimer: NodeJS.Timeout | null = null;
let savedAt = 0;
let staticLoaded = false;

/** Large ships in the area right now. Empty without a key; the first call starts the stream. */
export function currentShips(): LiveVehicle[] {
  if (!config.aisstreamKey) return [];
  askedAt = Date.now();
  if (!staticLoaded) loadStatic();
  if (!socket && !retryTimer) connect();
  if (Date.now() - savedAt > SAVE_MS) saveStatic();

  const now = Date.now() / 1000;
  const vehicles: LiveVehicle[] = [];
  for (const [mmsi, ship] of ships) {
    if (ship.length < MIN_LENGTH_M || ship.lon === undefined || ship.lat === undefined) continue;
    if (!ship.time || now - ship.time > MAX_AGE_S) continue;
    if (isRoadFerry(ship)) continue;
    vehicles.push({
      id: `ship:${mmsi}`,
      kind: "ship",
      lon: ship.lon,
      lat: ship.lat,
      bearing: ship.course ?? null,
      speed: ship.speed !== undefined ? ship.speed * KNOT_KMH : null,
      time: ship.time,
      name: titleCase(ship.name) || `MMSI ${mmsi}`,
      operator: shipType(ship.type),
      from: "",
      to: destination(ship.destination),
      length: ship.length,
    });
  }
  return vehicles;
}

function loadStatic(): void {
  staticLoaded = true;
  try {
    const saved = JSON.parse(readFileSync(STATIC_PATH, "utf8")) as Record<string, Ship>;
    // Runs before the stream first connects, so there's nothing to merge with.
    for (const [mmsi, ship] of Object.entries(saved)) ships.set(Number(mmsi), ship);
  } catch {
    // Nothing saved yet.
  }
  savedAt = Date.now();
}

function saveStatic(): void {
  savedAt = Date.now();
  const saved: Record<number, Ship> = {};
  for (const [mmsi, { name, type, length, destination }] of ships) {
    if (type || length) saved[mmsi] = { name, type, length, destination };
  }
  try {
    writeFileSync(STATIC_PATH, JSON.stringify(saved));
  } catch (err) {
    console.error("Could not save ship data:", err);
  }
}

function connect(): void {
  const ws = new WebSocket(URL);
  ws.binaryType = "arraybuffer";
  socket = ws;
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      APIKey: config.aisstreamKey,
      BoundingBoxes: [AREA],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));
  });
  ws.addEventListener("message", (event) => {
    retryMs = RETRY_MIN_MS;
    const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    try {
      handle(JSON.parse(text));
    } catch (err) {
      console.error("Bad AIS message:", err);
    }
    // Nobody is watching: stop streaming until someone asks again.
    if (Date.now() - askedAt > IDLE_MS) ws.close();
  });
  ws.addEventListener("close", () => {
    socket = null;
    if (Date.now() - askedAt > IDLE_MS) return;
    // Dropped while in use: reconnect, backing off if it keeps failing.
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  });
  ws.addEventListener("error", () => console.error("AIS stream error"));
}

interface AisMessage {
  MessageType: string;
  MetaData?: { MMSI: number; ShipName: string; latitude: number; longitude: number; time_utc: string };
  Message: {
    PositionReport?: { Cog: number; Sog: number; TrueHeading: number; Valid: boolean };
    ShipStaticData?: { Name: string; Type: number; Destination: string; Dimension: { A: number; B: number } };
  };
}

function handle(message: AisMessage): void {
  const meta = message.MetaData;
  if (!meta) return;
  let ship = ships.get(meta.MMSI);
  if (!ship) {
    ship = { name: meta.ShipName.trim(), type: 0, length: 0, destination: "" };
    ships.set(meta.MMSI, ship);
  }
  const data = message.Message.ShipStaticData;
  if (data) {
    ship.name = data.Name.trim() || ship.name;
    ship.type = data.Type;
    ship.length = data.Dimension.A + data.Dimension.B;
    ship.destination = data.Destination.trim();
  }
  const position = message.Message.PositionReport;
  if (position?.Valid) {
    ship.lon = meta.longitude;
    ship.lat = meta.latitude;
    // The course is where the ship is going (the heading can differ in wind);
    // 360 means no course and 511 no heading.
    ship.course = position.Cog < 360 ? position.Cog : position.TrueHeading < 360 ? position.TrueHeading : undefined;
    ship.speed = position.Sog < 102.3 ? position.Sog : undefined;
    ship.time = Date.parse(meta.time_utc.replace(/(\.\d{3})?\d* \+0000 UTC$/, "$1Z").replace(" ", "T")) / 1000;
  }
}

/** A passenger ship of a road ferry's size, on one of the road ferry routes. */
function isRoadFerry(ship: Ship): boolean {
  if (ship.type < 60 || ship.type >= 70 || ship.length > ROAD_FERRY_MAX_LENGTH_M) return false;
  const kx = 111_320 * Math.cos((ship.lat! * Math.PI) / 180);
  const ky = 111_320;
  return FERRY_ROUTES.some(({ path }) =>
    path.some(([lon, lat], i) => {
      if (i === 0) return false;
      const [lon0, lat0] = path[i - 1]!;
      // Distance from the ship to this stretch of the route, in meters.
      const ax = (lon0 - ship.lon!) * kx, ay = (lat0 - ship.lat!) * ky;
      const bx = (lon - ship.lon!) * kx, by = (lat - ship.lat!) * ky;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(ax + t * dx, ay + t * dy) < ROAD_FERRY_DISTANCE_M;
    }),
  );
}

/** AIS ship type codes, grouped as riders would name them. */
function shipType(type: number): string {
  if (type >= 60 && type < 70) return "Passagerarfartyg";
  if (type >= 70 && type < 80) return "Lastfartyg";
  if (type >= 80 && type < 90) return "Tankfartyg";
  if (type === 31 || type === 32 || type === 52) return "Bogserbåt";
  if (type === 33) return "Mudderverk";
  if (type === 35) return "Örlogsfartyg";
  if (type === 55) return "Kustbevakning";
  return "Fartyg";
}

// UN/LOCODEs ships often give as their destination, for ports around here.
const PORTS: Record<string, string> = {
  SESTO: "Stockholm", SEVHM: "Värtahamnen", SEFHM: "Frihamnen", SENYN: "Nynäshamn",
  SEKPS: "Kapellskär", SESOE: "Södertälje", SEVBY: "Visby", SEGRH: "Grisslehamn",
  SEVXH: "Vaxholm", SEOXE: "Oxelösund", SEVST: "Västerås", SEKOE: "Köping",
  FIHEL: "Helsingfors", FITKU: "Åbo", FIMHQ: "Mariehamn", FILAN: "Långnäs",
  FIEKS: "Eckerö", EETLL: "Tallinn", LVRIX: "Riga", LTKLJ: "Klaipėda",
  PLGDN: "Gdańsk", PLGDY: "Gdynia", DEROK: "Rostock", DEKEL: "Kiel",
};

/** A destination as riders would read it: "SESTO<>FIMHQ" -> "Stockholm ↔ Mariehamn". */
function destination(text: string): string {
  const named = text.replace(/\b([A-Z]{2}) ?([A-Z]{3})\b/g, (code, country: string, port: string) =>
    PORTS[country + port] ?? code);
  return titleCase(named.replace(/\s*<>\s*/g, " ↔ ").replace(/\s*>\s*/g, " → "));
}

/** "SILJA SERENADE" -> "Silja Serenade". */
function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s\-/>])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}
