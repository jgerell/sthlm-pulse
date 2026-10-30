import { config } from "./config.js";
import { stockholmTime } from "./gtfs/service.js";
import { ensureStaticGtfs } from "./gtfs/static.js";
import { startHttpServer } from "./http.js";
import { loadNetwork, type Network } from "./schedule/network.js";

// How often to check whether a new service day has started.
const DAY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function loadToday(): Promise<Network> {
  // Refreshes sl.zip too, at most once a day.
  const gtfsDir = await ensureStaticGtfs();
  return loadNetwork(gtfsDir, stockholmTime(new Date()).serviceDate);
}

let network = await loadToday();
startHttpServer(() => network, config.port, config.webDir);

// After midnight, build the new day's network in the background and swap it in.
// The old one keeps serving until the new one is ready.
let rebuilding = false;
setInterval(async () => {
  if (rebuilding || stockholmTime(new Date()).serviceDate === network.serviceDate) return;
  rebuilding = true;
  try {
    network = await loadToday();
  } catch (err) {
    console.error("Could not build the new day's network, will retry:", err);
  } finally {
    rebuilding = false;
  }
}, DAY_CHECK_INTERVAL_MS);
