// Local preview: serves public/ and the same API handlers as production, backed by an
// in-memory Postgres (PGlite) instead of Neon. Reservations reset when the server stops.
//   npm run dev            -> http://localhost:3000, invitation code 1234
//   INVITE_CODE=4321 PORT=4000 npm run dev
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { gifts } from "../public/gifts-full.js";
import { createHandlers } from "../lib/handlers.js";

const root = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const port = Number(process.env.PORT || 3000);
const env = { ...process.env, INVITE_CODE: process.env.INVITE_CODE || "1234", DATABASE_URL: "pglite://local" };

const pg = new PGlite();
const query = async (text, params) => (await pg.query(text, params)).rows;
const { login, reservations } = createHandlers({ query, giftIds: new Set(gifts.map((g) => g.id)), env });
const routes = { "/api/login": login, "/api/reservations": reservations };

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (routes[pathname]) {
    // Mirror the helpers Vercel adds to Node functions.
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(payload)); return res; };
    req.body = req.method === "POST" ? await readJson(req) : undefined;
    return routes[pathname](req, res);
  }

  const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Gift list preview: http://localhost:${port}  (invitation code ${env.INVITE_CODE})`));
