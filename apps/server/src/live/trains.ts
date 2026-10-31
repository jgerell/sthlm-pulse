// Regional and long-distance trains from Trafikverket: GPS positions
// (TrainPosition) joined with what the train is (TrainAnnouncement). SL's
// commuter trains are left out, since the timetable already draws them.
import { config } from "../config.js";
import type { LiveVehicle } from "./vehicles.js";
import { query, xml } from "../trafikverket.js";

// Positions update every few seconds; Trafikverket has no fixed quota, but
// there's no point asking more often than this.
const POLL_MS = 10_000;
// Positions older than this are trains standing still with their GPS off.
const MAX_AGE = "-0.00:05:00";
// Stockholm and Uppsala counties, roughly: lon lat, lon lat.
const AREA = "17.2 58.7, 19.4 60.1";
// Trains Trafikverket knows nothing about are looked up again after this long.
const UNKNOWN_RETRY_MS = 10 * 60_000;
const STATIONS_MAX_AGE_MS = 24 * 3600_000;
// Arlanda Express has no product name in the announcements.
const OWNER_NAMES: Record<string, string> = { "A-train": "Arlanda Express" };

interface Position {
  Train: { AdvertisedTrainNumber?: string; OperationalTrainNumber: string; JourneyPlanDepartureDate?: string };
  Position: { WGS84: string };
  TimeStamp: string;
  Bearing?: number;
  Speed?: number;
}

interface Announcement {
  AdvertisedTrainIdent: string;
  InformationOwner?: string;
  ProductInformation?: { Description: string }[];
  FromLocation?: { LocationName: string }[];
  ToLocation?: { LocationName: string }[];
}

interface TrainInfo {
  owner: string;
  product: string;
  from: string;
  to: string;
}

let vehicles: LiveVehicle[] = [];
let fetchedAt = 0;
/** Set once the first fetch has finished, successfully or not. */
let loaded = false;
let fetching: Promise<void> | null = null;
/** By `${train number}/${departure date}`; null when Trafikverket had nothing. */
const infos = new Map<string, { info: TrainInfo | null; at: number }>();
let stations: { names: Map<string, string>; at: number } | null = null;

/** Trains in the area right now, refreshing them first if due. Empty without a key. */
export async function currentTrains(): Promise<LiveVehicle[]> {
  if (!config.trafikverketKey) return [];
  if (Date.now() - fetchedAt > POLL_MS) fetching ??= refresh().finally(() => (fetching = null));
  // Serve the previous positions while new ones are on their way, except the very first time.
  if (!loaded) await fetching;
  return vehicles;
}

async function refresh(): Promise<void> {
  fetchedAt = Date.now();
  try {
    const positions = await query<Position>("TrainPosition", `
      <QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1">
        <FILTER><AND>
          <EQ name="Status.Active" value="true"/>
          <GT name="TimeStamp" value="$dateadd(${MAX_AGE})"/>
          <WITHIN name="Position.WGS84" shape="box" value="${AREA}"/>
        </AND></FILTER>
        <INCLUDE>Train</INCLUDE><INCLUDE>Position.WGS84</INCLUDE>
        <INCLUDE>TimeStamp</INCLUDE><INCLUDE>Bearing</INCLUDE><INCLUDE>Speed</INCLUDE>
      </QUERY>`);
    await lookUpTrains(positions);
    const names = await stationNames();
    const place = (signature: string) => names.get(signature) ?? signature;

    vehicles = positions.flatMap((p): LiveVehicle[] => {
      const number = p.Train.AdvertisedTrainNumber ?? p.Train.OperationalTrainNumber;
      const info = infos.get(infoKey(p))?.info ?? null;
      if (info?.owner === "SL") return [];
      const [lon, lat] = parsePoint(p.Position.WGS84);
      if (lon === undefined || lat === undefined) return [];
      return [{
        id: `train:${p.Train.OperationalTrainNumber}`,
        kind: "train",
        lon,
        lat,
        bearing: p.Bearing ?? null,
        speed: p.Speed ?? null,
        time: Date.parse(p.TimeStamp) / 1000,
        name: `${info?.product || "Tåg"} ${number}`,
        operator: info?.owner ?? "",
        from: info ? place(info.from) : "",
        to: info ? place(info.to) : "",
      }];
    });
  } catch (err) {
    console.error("Could not fetch train positions:", err);
  }
  loaded = true;
}

function infoKey(p: Position): string {
  return `${p.Train.AdvertisedTrainNumber ?? p.Train.OperationalTrainNumber}/${p.Train.JourneyPlanDepartureDate ?? ""}`;
}

/** Fetches what each new train is, one query per departure date. */
async function lookUpTrains(positions: Position[]): Promise<void> {
  const now = Date.now();
  const byDate = new Map<string, Set<string>>();
  for (const p of positions) {
    const known = infos.get(infoKey(p));
    if (known && (known.info || now - known.at < UNKNOWN_RETRY_MS)) continue;
    const date = p.Train.JourneyPlanDepartureDate;
    const number = p.Train.AdvertisedTrainNumber;
    if (!date || !number) continue;
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date)!.add(number);
  }

  for (const [date, numbers] of byDate) {
    const rows = await query<Announcement>("TrainAnnouncement", `
      <QUERY objecttype="TrainAnnouncement" schemaversion="1.9">
        <FILTER><AND>
          <EQ name="ScheduledDepartureDateTime" value="${xml(date)}"/>
          <EQ name="ActivityType" value="Avgang"/>
          <IN name="AdvertisedTrainIdent" value="${xml([...numbers].join(","))}"/>
        </AND></FILTER>
        <INCLUDE>AdvertisedTrainIdent</INCLUDE><INCLUDE>InformationOwner</INCLUDE>
        <INCLUDE>ProductInformation</INCLUDE><INCLUDE>FromLocation</INCLUDE><INCLUDE>ToLocation</INCLUDE>
      </QUERY>`);
    for (const number of numbers) infos.set(`${number}/${date}`, { info: null, at: now });
    // A train has one row per station; only some carry the train's details.
    for (const row of rows) {
      const key = `${row.AdvertisedTrainIdent}/${date}`;
      if (infos.get(key)?.info || !row.InformationOwner) continue;
      infos.set(key, {
        info: {
          owner: row.InformationOwner,
          product: row.ProductInformation?.[0]?.Description ?? OWNER_NAMES[row.InformationOwner] ?? "",
          from: row.FromLocation?.[0]?.LocationName ?? "",
          to: row.ToLocation?.[0]?.LocationName ?? "",
        },
        at: now,
      });
    }
  }
  // Yesterday's trains are no longer needed.
  for (const [key, entry] of infos) if (now - entry.at > 2 * STATIONS_MAX_AGE_MS) infos.delete(key);
}

/** Station names by signature ("Cst" -> "Stockholm C"), refreshed daily. */
async function stationNames(): Promise<Map<string, string>> {
  if (stations && Date.now() - stations.at < STATIONS_MAX_AGE_MS) return stations.names;
  const rows = await query<{ LocationSignature: string; AdvertisedLocationName: string }>("TrainStation", `
    <QUERY objecttype="TrainStation" namespace="rail.infrastructure" schemaversion="1.5">
      <INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedLocationName</INCLUDE>
    </QUERY>`);
  stations = { names: new Map(rows.map((r) => [r.LocationSignature, r.AdvertisedLocationName])), at: Date.now() };
  return stations.names;
}

/** "POINT (18.05 59.33)" -> [18.05, 59.33]. */
function parsePoint(wkt: string): number[] {
  return wkt.replace(/^POINT \(|\)$/g, "").split(" ").map(Number);
}
