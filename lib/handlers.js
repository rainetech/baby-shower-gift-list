import {
  COOKIE_NAME,
  codeMatches,
  createSessionToken,
  parseCookies,
  sessionCookie,
  verifySessionToken
} from "./auth.js";
import { ensureSchema } from "./schema.js";

const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW = "15 minutes";
const MAX_NAME_LENGTH = 50;

function send(res, status, payload, headers = {}) {
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  return res.status(status).json(payload);
}

function readBody(req) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

const isJson = (req) => String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json");

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return String(req.headers["x-real-ip"] || forwarded || "unknown");
}

function isLocalHost(req) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host || ""));
}

export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

const toReservation = (row) => ({
  itemId: row.item_id,
  name: row.name,
  reservedAt: new Date(row.reserved_at).toISOString()
});

// `query(text, params)` resolves to an array of rows. `giftIds` is the set of valid gift ids.
export function createHandlers({ query, giftIds, env = process.env, now = Date.now }) {
  async function login(req, res) {
    try {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
      if (!isJson(req)) return send(res, 415, { error: "json_required" });
      if (!env.INVITE_CODE) return send(res, 500, { error: "not_configured" });

      await ensureSchema(query);
      const ip = clientIp(req);
      const [{ failed }] = await query(
        `select count(*)::int as failed from login_attempts where ip = $1 and attempted_at > now() - interval '${LOGIN_WINDOW}'`,
        [ip]
      );
      if (failed >= MAX_FAILED_LOGINS) return send(res, 429, { error: "too_many_attempts" }, { "Retry-After": "900" });

      if (!codeMatches(readBody(req).code, env.INVITE_CODE)) {
        await query("insert into login_attempts (ip) values ($1)", [ip]);
        await query("delete from login_attempts where attempted_at < now() - interval '1 day'");
        return send(res, 401, { error: "invalid_code" });
      }

      const cookie = sessionCookie(createSessionToken(env, now()), { secure: !isLocalHost(req) });
      return send(res, 200, { ok: true }, { "Set-Cookie": cookie });
    } catch (error) {
      console.error("login failed", error);
      return send(res, 500, { error: "server_error" });
    }
  }

  async function reservations(req, res) {
    try {
      if (req.method !== "GET" && req.method !== "POST") {
        return send(res, 405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
      }
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (!env.INVITE_CODE || !verifySessionToken(token, env, now())) return send(res, 401, { error: "unauthorized" });

      await ensureSchema(query);

      if (req.method === "GET") {
        const rows = await query("select item_id, name, reserved_at from reservations order by reserved_at");
        return send(res, 200, { reservations: rows.map(toReservation) });
      }

      if (!isJson(req)) return send(res, 415, { error: "json_required" });
      const { itemId, name: rawName } = readBody(req);
      if (typeof itemId !== "string" || !giftIds.has(itemId)) return send(res, 400, { error: "unknown_item" });
      const name = normalizeName(rawName);
      if (!name || [...name].length > MAX_NAME_LENGTH) return send(res, 400, { error: "invalid_name" });

      const rows = await query(
        `insert into reservations (item_id, name) values ($1, $2)
         on conflict (item_id) do nothing
         returning item_id, name, reserved_at`,
        [itemId, name]
      );
      if (!rows.length) return send(res, 409, { error: "already_reserved" });
      return send(res, 201, { reservation: toReservation(rows[0]) });
    } catch (error) {
      console.error("reservations failed", error);
      return send(res, 500, { error: "server_error" });
    }
  }

  return { login, reservations };
}
