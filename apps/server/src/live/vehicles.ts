// Vehicles shown by their GPS position rather than from a timetable. They have
// no history, so the map only shows them in live mode.
import { currentTrains } from "./trains.js";

export interface LiveVehicle {
  /** Stable while the vehicle is on the map, e.g. "train:568". */
  id: string;
  kind: "train";
  lon: number;
  lat: number;
  /** Degrees clockwise from north; null when unknown. */
  bearing: number | null;
  /** km/h; null when unknown. */
  speed: number | null;
  /** When the position was measured (Unix seconds). */
  time: number;
  /** e.g. "SJ Snabbtåg 568". */
  name: string;
  operator: string;
  from: string;
  to: string;
}

export async function liveVehicles(): Promise<LiveVehicle[]> {
  return currentTrains();
}
