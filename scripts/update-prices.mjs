#!/usr/bin/env node
// Refreshes Amazon.ae wishlist prices and the other-retailer prices, then rewrites
// public/gifts-full.js and public/alternative-prices.js.
//
//   node scripts/update-prices.mjs [--dry-run] [--skip-amazon] [--skip-retailers]
//
// Prints a Markdown report. Exit code 0 = ran (check the report), 1 = nothing could be refreshed.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchWishlist } from "./lib/amazon.mjs";
import { extractOffer } from "./lib/retailers.mjs";
import { applyAmazonPrices, applyRetailerChecks, renderAlternativesModule, renderGiftsModule, renderReport } from "./lib/update.mjs";

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
const alternatives = await load("alternative-prices.js");
let nextGifts = gifts;
let amazonDate = previousAmazonDate;
let nextAlternatives = { priceCheckDate: alternatives.priceCheckDate, alternativePrices: alternatives.alternativePrices };

if (!args.has("--skip-amazon")) {
  try {
    const scraped = await fetchWishlist(createFetcher());
    const applied = applyAmazonPrices(gifts, scraped);
    nextGifts = applied.gifts;
    result.amazon = applied.report;
    amazonDate = today;
  } catch (error) {
    result.amazonError = error.message;
  }
}

if (!args.has("--skip-retailers")) {
  try {
    const get = createFetcher();
    const urls = [...new Set(Object.values(nextAlternatives.alternativePrices).flat().map((offer) => offer.url))];
    const checks = new Map();
    for (const url of urls) {
      try {
        const offer = extractOffer(await get(url), url);
        checks.set(url, offer ? { ok: true, ...offer } : { ok: false, reason: "no price found on the page" });
      } catch (error) {
        checks.set(url, { ok: false, reason: error.message });
      }
      await sleep(400);
    }
    const applied = applyRetailerChecks(nextAlternatives, checks, { today });
    nextAlternatives = applied.alternatives;
    result.retailers = applied.report;
  } catch (error) {
    result.retailerError = error.message;
  }
}

const refreshedAnything = Boolean(result.amazon || result.retailers);
if (refreshedAnything && !args.has("--dry-run")) {
  writeFileSync(root + "gifts-full.js", renderGiftsModule(nextGifts, amazonDate));
  writeFileSync(root + "alternative-prices.js", renderAlternativesModule(nextAlternatives, nextGifts));
  result.wrote = true;
}

console.log(renderReport(result));
process.exit(refreshedAnything ? 0 : 1);
