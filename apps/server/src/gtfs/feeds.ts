// GTFS-RT feeds from Trafiklab, fetched on demand with a minimum interval.
//
// The Bronze quota is ~1 000 requests a day across all realtime feeds, so each
// feed is fetched only when a browser asks for its data, and no more often than
// its interval: with nobody on the site, nothing is fetched. The last response
// is kept in data/, so a server restart reuses it instead of spending another
// request.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

export interface Feed {
  /** The latest feed body, refreshing it first if it's due. Null if realtime is off or unavailable. */
  get(): Promise<Buffer | null>;
}

export function cachedFeed(name: string, intervalMs: number): Feed {
  const url = `https://opendata.samtrafiken.se/gtfs-rt/sl/${name}.pb`;
  const snapshotPath = join(config.dataDir, `${name}.pb`);
  let buffer: Buffer | null = null;
  // Last fetch attempt, successful or not, so failures don't retry on every request.
  let attemptedAt = 0;
  let fetching: Promise<void> | null = null;
  let snapshotLoaded = false;

  async function loadSnapshot(): Promise<void> {
    snapshotLoaded = true;
    try {
      const { mtimeMs } = await stat(snapshotPath);
      buffer = await readFile(snapshotPath);
      attemptedAt = mtimeMs;
    } catch {
      // No snapshot yet.
    }
  }

  async function fetchFeed(key: string): Promise<void> {
    attemptedAt = Date.now();
    try {
      const res = await fetch(`${url}?key=${key}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(snapshotPath, buffer);
    } catch (err) {
      console.error(`Could not fetch ${name}:`, err);
    }
  }

  return {
    async get() {
      const key = config.trafiklab.realtimeKey;
      if (!key) return null;
      if (!snapshotLoaded) await loadSnapshot();
      if (Date.now() - attemptedAt > intervalMs) {
        fetching ??= fetchFeed(key).finally(() => (fetching = null));
        // Serve the previous body while a new one is on its way.
        if (!buffer) await fetching;
      }
      return buffer;
    },
  };
}
