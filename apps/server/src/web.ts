import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg"]);

interface WebFile {
  type: string;
  body: Buffer;
  gzipped: Buffer | null;
  cacheControl: string;
}

/**
 * Serves the built web app (`vite build` output) from memory. Files under
 * `assets/` have content hashes in their names, so they can be cached for good;
 * everything else is revalidated. Returns null when there is no build, as in
 * development, where Vite serves the app.
 */
export function webApp(dir: string): ((req: IncomingMessage, res: ServerResponse) => boolean) | null {
  if (!existsSync(join(dir, "index.html"))) return null;

  const files = new Map<string, WebFile>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const ext = extname(name);
      const body = readFileSync(path);
      const urlPath = "/" + relative(dir, path).split(sep).join("/");
      files.set(urlPath, {
        type: TYPES[ext] ?? "application/octet-stream",
        body,
        gzipped: COMPRESSIBLE.has(ext) ? gzipSync(body) : null,
        cacheControl: urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
  };
  walk(dir);

  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = files.get(pathname === "/" ? "/index.html" : pathname);
    if (!file) return false;
    const gzip = file.gzipped && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const body = gzip ? file.gzipped! : file.body;
    res.writeHead(200, {
      "Content-Type": file.type,
      "Content-Length": body.length,
      "Cache-Control": file.cacheControl,
      Vary: "Accept-Encoding",
      ...(gzip && { "Content-Encoding": "gzip" }),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}
