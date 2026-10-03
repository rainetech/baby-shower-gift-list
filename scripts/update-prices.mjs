#!/usr/bin/env node
// Refreshes the Amazon.ae wishlist prices and rewrites public/gifts-full.js.
//
//   node scripts/update-prices.mjs [--dry-run]
//
// Prints a Markdown report. Exit code 0 = ran (check the report), 1 = the prices could not be refreshed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchWishlist } from "./lib/amazon.mjs";
import { applyAmazonPrices, renderGiftsModule, renderReport } from "./lib/update.mjs";

// Node's fetch ignores proxy settings unless NODE_USE_ENV_PROXY is set (Node 22.21+); sandboxed
// environments need it, so relaunch once with it on.
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
  process.exit(child.status ?? 1);
}

const args = new Set(process.argv.slice(2));
const root = fileURLToPath(new URL("../public/", import.meta.url));
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gulfToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "numeric", year: "numeric" })
    .formatToParts(now).map((part) => [part.type, part.value]));
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}`;
}

// A fetcher that keeps cookies per host (Amazon's wishlist paging needs its session cookies) and
// never sends one site's cookies to another.
function createFetcher() {
  const jars = new Map();
  return async function get(url, retries = 1) {
    const host = new URL(url).hostname;
    const jar = jars.get(host) ?? jars.set(host, new Map()).get(host);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            "user-agent": USER_AGENT,
            "accept-language": "en-AE,en;q=0.9",
            ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") } : {})
          },
          redirect: "follow",
          signal: AbortSignal.timeout(30000)
        });
        for (const cookie of response.headers.getSetCookie?.() ?? []) {
          const pair = cookie.split(";")[0];
          const index = pair.indexOf("=");
          if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1));
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(1500);
      }
    }
  };
}

const load = async (file) => import(`${pathToFileURL(root + file).href}?t=${Date.now()}`);
const today = gulfToday();
const result = { today, wrote: false };

const { gifts, amazonPricesCheckedOn: previousAmazonDate } = await load("gifts-full.js");
let nextGifts = gifts;
let amazonDate = previousAmazonDate;

try {
  const scraped = await fetchWishlist(createFetcher());
  const acknowledged = new Set(JSON.parse(readFileSync(new URL("./ignore.json", import.meta.url), "utf8")));
  const applied = applyAmazonPrices(gifts, scraped, { acknowledged });
  nextGifts = applied.gifts;
  result.amazon = applied.report;
  amazonDate = today;
} catch (error) {
  result.amazonError = error.message;
}

if (result.amazon && !args.has("--dry-run")) {
  writeFileSync(root + "gifts-full.js", renderGiftsModule(nextGifts, amazonDate));
  result.wrote = true;
}

console.log(renderReport(result));
process.exit(result.amazon ? 0 : 1);
