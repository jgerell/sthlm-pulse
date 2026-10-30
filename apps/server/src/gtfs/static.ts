import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { config } from "../config.js";

// Bronze quota is 60 downloads / 30 days, so never fetch more than once a day.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const zipPath = join(config.dataDir, "sl.zip");
const gtfsDir = join(config.dataDir, "sl");

/**
 * Makes sure an extracted copy of SL's static GTFS exists in data/sl and
 * returns its path. Downloads sl.zip only when the cached copy is missing
 * or older than 24 hours.
 */
export async function ensureStaticGtfs(): Promise<string> {
  await mkdir(config.dataDir, { recursive: true });

  const age = await fileAgeMs(zipPath);
  if (age === null || age > MAX_AGE_MS) {
    try {
      await download(zipPath);
      await rm(gtfsDir, { recursive: true, force: true });
    } catch (err) {
      if (age === null) throw err;
      console.warn(`Could not refresh sl.zip, using cached copy: ${(err as Error).message}`);
    }
  }

  if ((await fileAgeMs(gtfsDir)) === null) {
    await extract(zipPath, gtfsDir);
  }
  return gtfsDir;
}

async function fileAgeMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function download(dest: string): Promise<void> {
  const url = `https://opendata.samtrafiken.se/gtfs/sl/sl.zip?key=${config.trafiklab.staticKey}`;
  console.log("Downloading sl.zip from Trafiklab...");

  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  if (!res.ok || !res.body) {
    throw new Error(`sl.zip download failed: HTTP ${res.status}`);
  }

  // Write to a temp file first so a failed download never replaces a good cache.
  const tmp = `${dest}.tmp`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);

  const size = (await stat(dest)).size;
  console.log(`Downloaded sl.zip (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function extract(zip: string, outDir: string): Promise<void> {
  const tmpDir = `${outDir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zip, { lazyEntries: true }, (err, file) => {
      if (err) return reject(err);
      file.on("error", reject);
      file.on("end", resolve);
      file.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) return file.readEntry();
        file.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          // basename() keeps every file inside outDir, whatever paths the zip contains.
          pipeline(stream, createWriteStream(join(tmpDir, basename(entry.fileName))))
            .then(() => file.readEntry(), reject);
        });
      });
      file.readEntry();
    });
  });

  await rename(tmpDir, outDir);
}
