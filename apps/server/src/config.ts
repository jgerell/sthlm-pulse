import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));

// Locally, settings come from .env in the repo root. On a host they're set as
// environment variables instead, so a missing file is fine.
try {
  process.loadEnvFile(`${rootDir}.env`);
} catch {
  // No .env file; rely on the environment.
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env (cp .env.example .env) or as an environment variable.`,
    );
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

export const config = {
  dataDir: `${rootDir}data`,
  /** The built web app (npm run build), served by the API server in production. */
  webDir: `${rootDir}apps/web/dist`,
  port: number("API_PORT", 4280),
  trafiklab: {
    staticKey: required("TRAFIKLAB_GTFS_STATIC_KEY"),
    /** Optional: without it the map runs on the timetable alone. */
    realtimeKey: process.env.TRAFIKLAB_GTFS_RT_KEY || null,
  },
  /** Optional: Trafikverket's open API, for regional and long-distance trains. */
  trafikverketKey: process.env.TRAFIKVERKET_API_KEY || null,
  /** Optional: AISStream, for large ships. */
  aisstreamKey: process.env.AISSTREAM_API_KEY || null,
};
