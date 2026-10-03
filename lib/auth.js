import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "registry_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 30;

const digest = (value) => createHash("sha256").update(String(value)).digest();

export function codeMatches(submitted, expected) {
  if (typeof submitted !== "string" || !expected) return false;
  return timingSafeEqual(digest(submitted.trim()), digest(String(expected).trim()));
}

// SESSION_SECRET is optional: without it the key is derived from the invitation code and database
// URL, so changing either one signs every guest out.
function signingKey(env) {
  return env.SESSION_SECRET || `${env.INVITE_CODE}:${env.DATABASE_URL || env.POSTGRES_URL}`;
}

function sign(payload, env) {
  return createHmac("sha256", signingKey(env)).update(payload).digest("base64url");
}

export function createSessionToken(env, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  return `${expires}.${sign(String(expires), env)}`;
}

export function verifySessionToken(token, env, nowMs = Date.now()) {
  if (typeof token !== "string") return false;
  const [expires, signature, ...rest] = token.split(".");
  if (!expires || !signature || rest.length) return false;
  const expected = Buffer.from(sign(expires, env));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  return Number(expires) > Math.floor(nowMs / 1000);
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

export function sessionCookie(token, { secure = true } = {}) {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_SECONDS}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}
