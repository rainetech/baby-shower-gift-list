import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { COOKIE_NAME, createSessionToken, verifySessionToken } from "../lib/auth.js";
import { createHandlers, normalizeName } from "../lib/handlers.js";
import { resetSchemaCache } from "../lib/schema.js";

const env = { INVITE_CODE: "1234", DATABASE_URL: "postgres://test", NODE_ENV: "test" };
const giftIds = new Set(["B000000001", "B000000002", "B000000003"]);

const pg = new PGlite();
const query = async (text, params) => (await pg.query(text, params)).rows;
const handlers = createHandlers({ query, giftIds, env });

function request({ method = "GET", body, cookie, json = true, ip = "203.0.113.7" } = {}) {
  const headers = { "x-forwarded-for": ip, host: "gifts.example.com" };
  if (json) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return { method, headers, body };
}

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

async function call(handler, options) {
  const res = response();
  await handler(request(options), res);
  return res;
}

async function signIn() {
  const res = await call(handlers.login, { method: "POST", body: { code: "1234" } });
  assert.equal(res.statusCode, 200);
  return res.headers["Set-Cookie"].split(";")[0];
}

beforeEach(async () => {
  resetSchemaCache();
  await pg.exec("drop table if exists reservations; drop table if exists login_attempts;");
});

after(() => pg.close());

describe("login", () => {
  it("accepts the invitation code and sets a hardened session cookie", async () => {
    const res = await call(handlers.login, { method: "POST", body: { code: " 1234 " } });
    assert.equal(res.statusCode, 200);
    const cookie = res.headers["Set-Cookie"];
    assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(cookie.includes(attribute), attribute);
    assert.equal(res.headers["Cache-Control"], "no-store");
  });

  it("rejects a wrong code without setting a cookie", async () => {
    const res = await call(handlers.login, { method: "POST", body: { code: "0000" } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["Set-Cookie"], undefined);
  });

  it("rejects missing or non-string codes", async () => {
    for (const body of [{}, { code: 1234 }, { code: null }, "not json", undefined]) {
      const res = await call(handlers.login, { method: "POST", body });
      assert.equal(res.statusCode, 401, JSON.stringify(body));
    }
  });

  it("requires JSON and POST", async () => {
    assert.equal((await call(handlers.login, { method: "POST", body: { code: "1234" }, json: false })).statusCode, 415);
    assert.equal((await call(handlers.login, { method: "GET" })).statusCode, 405);
  });

  it("fails closed when no invitation code is configured", async () => {
    const unconfigured = createHandlers({ query, giftIds, env: { DATABASE_URL: "x" } });
    const res = await call(unconfigured.login, { method: "POST", body: { code: "" } });
    assert.equal(res.statusCode, 500);
  });

  it("throttles an IP after 10 wrong codes, even for the right code, but not other IPs", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await call(handlers.login, { method: "POST", body: { code: "9999" } })).statusCode, 401);
    }
    const blocked = await call(handlers.login, { method: "POST", body: { code: "1234" } });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers["Retry-After"], "900");

    const other = await call(handlers.login, { method: "POST", body: { code: "1234" }, ip: "198.51.100.9" });
    assert.equal(other.statusCode, 200);
  });
});

describe("session tokens", () => {
  it("verifies its own tokens and rejects tampered, foreign and expired ones", () => {
    const token = createSessionToken(env, 1_000_000);
    assert.equal(verifySessionToken(token, env, 1_000_000), true);
    assert.equal(verifySessionToken(token, { ...env, INVITE_CODE: "9999" }, 1_000_000), false);
    assert.equal(verifySessionToken(`${Number(token.split(".")[0]) + 1}.${token.split(".")[1]}`, env, 1_000_000), false);
    assert.equal(verifySessionToken(token, env, 1_000_000 + 31 * 24 * 3600 * 1000), false);
    for (const junk of [undefined, "", "abc", "1.2.3", "9999999999."]) assert.equal(verifySessionToken(junk, env), false);
  });
});

describe("reservations", () => {
  it("requires a valid session", async () => {
    assert.equal((await call(handlers.reservations)).statusCode, 401);
    assert.equal((await call(handlers.reservations, { cookie: `${COOKIE_NAME}=forged.token` })).statusCode, 401);
    const post = await call(handlers.reservations, {
      method: "POST", body: { itemId: "B000000001", name: "Sam" }, cookie: `${COOKIE_NAME}=forged.token`
    });
    assert.equal(post.statusCode, 401);
  });

  it("lists reservations (empty at first) and creates the schema on demand", async () => {
    const cookie = await signIn();
    const res = await call(handlers.reservations, { cookie });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { reservations: [] });
  });

  it("books a gift and shows it to everyone", async () => {
    const cookie = await signIn();
    const created = await call(handlers.reservations, {
      method: "POST", body: { itemId: "B000000001", name: "  Aunty   Sam " }, cookie
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.reservation.itemId, "B000000001");
    assert.equal(created.body.reservation.name, "Aunty Sam");
    assert.ok(!Number.isNaN(Date.parse(created.body.reservation.reservedAt)));

    const listed = await call(handlers.reservations, { cookie });
    assert.deepEqual(listed.body.reservations.map((r) => [r.itemId, r.name]), [["B000000001", "Aunty Sam"]]);
  });

  it("refuses to book the same gift twice and keeps the first guest's name", async () => {
    const cookie = await signIn();
    await call(handlers.reservations, { method: "POST", body: { itemId: "B000000002", name: "First" }, cookie });
    const second = await call(handlers.reservations, { method: "POST", body: { itemId: "B000000002", name: "Second" }, cookie });
    assert.equal(second.statusCode, 409);
    const listed = await call(handlers.reservations, { cookie });
    assert.deepEqual(listed.body.reservations.map((r) => r.name), ["First"]);
  });

  it("lets only one of two simultaneous guests win a gift", async () => {
    const cookie = await signIn();
    const results = await Promise.all(["Ann", "Ben", "Cat", "Dan", "Eve"].map((name) =>
      call(handlers.reservations, { method: "POST", body: { itemId: "B000000003", name }, cookie })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409, 409, 409]);
    const [{ count }] = await query("select count(*)::int as count from reservations");
    assert.equal(count, 1);
  });

  it("rejects unknown gifts and bad names", async () => {
    const cookie = await signIn();
    const post = (body) => call(handlers.reservations, { method: "POST", body, cookie });
    assert.equal((await post({ itemId: "NOPE", name: "Sam" })).statusCode, 400);
    assert.equal((await post({ name: "Sam" })).statusCode, 400);
    assert.equal((await post({ itemId: ["B000000001"], name: "Sam" })).statusCode, 400);
    assert.equal((await post({ itemId: "B000000001", name: "   " })).statusCode, 400);
    assert.equal((await post({ itemId: "B000000001", name: 42 })).statusCode, 400);
    assert.equal((await post({ itemId: "B000000001", name: "x".repeat(51) })).statusCode, 400);
    assert.equal((await post({ itemId: "B000000001", name: "x".repeat(50) })).statusCode, 201);
    assert.equal((await call(handlers.reservations, { method: "POST", body: { itemId: "B000000002", name: "Sam" }, cookie, json: false })).statusCode, 415);
  });

  it("stores names as plain text and never allows editing or deleting", async () => {
    const cookie = await signIn();
    const created = await call(handlers.reservations, {
      method: "POST", body: { itemId: "B000000001", name: "<img src=x onerror=alert(1)>" }, cookie
    });
    assert.equal(created.body.reservation.name, "<img src=x onerror=alert(1)>");
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await call(handlers.reservations, { method, cookie })).statusCode, 405);
    }
  });
});

describe("normalizeName", () => {
  it("collapses whitespace and strips control characters", () => {
    assert.equal(normalizeName("  A\u0000B\n\tC  "), "A B C");
    assert.equal(normalizeName(undefined), "");
  });
});
