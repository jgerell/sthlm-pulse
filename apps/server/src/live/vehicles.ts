// Vehicles shown by their GPS position rather than from a timetable. They have
// no history, so the map only shows them in live mode.
import { currentShips } from "./ships.js";
import { currentTrains } from "./trains.js";

export interface LiveVehicle {
  /** Stable while the vehicle is on the map, e.g. "train:568". */
  id: string;
  kind: "train" | "ship";
  lon: number;
  lat: number;
  /** Degrees clockwise from north; null when unknown. */
  bearing: number | null;
  /** km/h; null when unknown. */
  speed: number | null;
  /** When the position was measured (Unix seconds). */
  time: number;
  /** e.g. "SJ Snabbtåg 568", "Silja Serenade". */
  name: string;
  /** Trains: the operator. Ships: the kind of ship, e.g. "Lastfartyg". */
  operator: string;
  from: string;
  to: string;
  /** Ships: length in meters. */
  length?: number;
}

export async function liveVehicles(): Promise<LiveVehicle[]> {
  const trains = await currentTrains();
  return [...trains, ...currentShips()];
}
