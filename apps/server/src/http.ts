import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { currentAlerts } from "./gtfs/alerts.js";
import { currentDelays } from "./gtfs/realtime.js";
import { dailyStats } from "./schedule/stats.js";
import { stationDetails, tripDetails, tripsInWindow, type Network } from "./schedule/network.js";
import { webApp } from "./web.js";

// Trip windows are capped so a single request can't ask for the whole day.
const MAX_WINDOW_S = 3 * 3600;

interface PreparedNetwork {
  network: Network;
  body: Buffer;
  etag: string;
}

/** Routes and shapes don't change during a day, so they're compressed once per network. */
function prepare(network: Network): PreparedNetwork {
  const body = gzipSync(JSON.stringify({
    serviceDate: network.serviceDate,
    routes: network.routes,
    shapes: network.shapes,
    stations: network.stations,
    stats: dailyStats(network),
    activity: activityProfile(network),
  }));
  // Trip ids and shape indexes only make sense together with the network they
  // came from, so the browser must revalidate it (cheaply, via the ETag)
  // instead of reusing a copy from before a rebuild.
  const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
  return { network, body, etag };
}

/**
 * Serves the API, and the built web app from `webDir` when there is one.
 * `getNetwork` is called per request, so the server picks up a new day's
 * network as soon as it has been built.
 */
export function startHttpServer(getNetwork: () => Network, port: number, webDir: string): void {
  let prepared = prepare(getNetwork());
  const web = webApp(webDir);

  const server = createServer((req, res) => {
    if (prepared.network !== getNetwork()) prepared = prepare(getNetwork());
    const { network } = prepared;
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/network") {
      if (req.headers["if-none-match"] === prepared.etag) {
        res.writeHead(304, { ETag: prepared.etag }).end();
        return;
      }
      return sendGzippedJson(res, prepared.body, "no-cache", prepared.etag);
    }

    // Trip ids are only valid for one service date, so responses carry it and
    // the client reloads the network when it changes.
    const serviceDate = network.serviceDate;

    if (url.pathname === "/api/trips") {
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > MAX_WINDOW_S) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(
          `from and to must be seconds since midnight, at most ${MAX_WINDOW_S} s apart`,
        );
        return;
      }
      const trips = tripsInWindow(network, from, to);
      return sendGzippedJson(res, gzipSync(JSON.stringify({ serviceDate, trips })), "no-cache");
    }

    if (url.pathname === "/api/trip") {
      const details = tripDetails(network, Number(url.searchParams.get("id")));
      if (!details) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("No such trip");
        return;
      }
      return sendGzippedJson(res, gzipSync(JSON.stringify({ serviceDate, ...details })), "no-cache");
    }

    if (url.pathname === "/api/delays") {
      currentDelays(network).then(
        (rt) => {
          // Flat [trip, seconds late, ...]; null fields mean realtime is off.
          const latest = rt?.latest && network.trips[rt.latest.trip];
          const body = {
            serviceDate,
            updatedAt: rt?.updatedAt ?? null,
            delays: rt ? [...rt.delays].flat() : [],
            canceled: rt ? [...rt.canceled] : [],
            onTimeShare: rt?.onTimeShare ?? null,
            latest: latest
              ? { route: latest.route, headsign: latest.headsign, delay: rt!.latest!.delay }
              : null,
          };
          sendGzippedJson(res, gzipSync(JSON.stringify(body)), "no-cache");
        },
        (err) => {
          console.error(err);
          res.writeHead(500, { "Content-Type": "text/plain" }).end("Realtime unavailable");
        },
      );
      return;
    }

    if (url.pathname === "/api/alerts") {
      currentAlerts(network).then(
        (alerts) => sendGzippedJson(res, gzipSync(JSON.stringify({ serviceDate, alerts })), "no-cache"),
        (err) => {
          console.error(err);
          res.writeHead(500, { "Content-Type": "text/plain" }).end("Alerts unavailable");
        },
      );
      return;
    }

    if (url.pathname === "/api/station") {
      const details = stationDetails(network, Number(url.searchParams.get("id")));
      if (!details) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("No such station");
        return;
      }
      return sendGzippedJson(res, gzipSync(JSON.stringify({ serviceDate, ...details })), "no-cache");
    }

    if (web?.(req, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  });

  server.listen(port, () =>
    console.log(`${web ? "Site" : "API"} listening on http://localhost:${port}`),
  );
}

const ACTIVITY_BIN_S = 600;

/** Number of trips on the road in each 10-minute slot of the day (144 values). */
function activityProfile(network: Network): number[] {
  const bins = new Array<number>(86_400 / ACTIVITY_BIN_S).fill(0);
  for (const trip of network.trips) {
    const first = Math.max(0, Math.ceil(trip.start / ACTIVITY_BIN_S));
    const last = Math.min(bins.length - 1, Math.floor(trip.end / ACTIVITY_BIN_S));
    for (let i = first; i <= last; i++) bins[i]!++;
  }
  return bins;
}

function sendGzippedJson(
  res: ServerResponse,
  body: Buffer,
  cacheControl: string,
  etag?: string,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    "Cache-Control": cacheControl,
    ...(etag && { ETag: etag }),
  });
  res.end(body);
}
