#!/usr/bin/env node
// Applies a "Remove gift <ASIN>" or "Keep gift <ASIN> at AED <price>" decision, taken from the title of
// a GitHub issue (see .github/workflows/gift-decision.yml). Prints a Markdown reply for the issue.
// Exit code 0 = applied, 2 = refused or not understood (nothing changed).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyDecision, parseDecisionTitle } from "./lib/decision.mjs";
import { fetchReservedIds } from "./lib/reservations.mjs";
import { renderGiftsModule } from "./lib/update.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const ignorePath = fileURLToPath(new URL("./ignore.json", import.meta.url));

function stop(message) {
  console.log(message);
  process.exit(2);
}

const decision = parseDecisionTitle(process.env.TITLE);
if (!decision) stop("I couldn't understand that title, so nothing was changed. It must be exactly `Remove gift <ASIN>` or `Keep gift <ASIN> at AED <price>`.");

const { gifts, amazonPricesCheckedOn } = await import(pathToFileURL(root + "gifts-full.js").href);
const { firebaseConfig, registryUserEmail } = await import(pathToFileURL(root + "firebase-config.js").href);
const ignore = JSON.parse(readFileSync(ignorePath, "utf8"));

let reserved;
try {
  reserved = await fetchReservedIds({ firebaseConfig, email: registryUserEmail, code: process.env.INVITE_CODE });
} catch (error) {
  stop(`I couldn't check whether a guest has reserved this gift, so nothing was changed. ${error.message}`);
}

const outcome = applyDecision(gifts, ignore, decision, { reserved });
if (!outcome.ok) stop(outcome.message);

writeFileSync(root + "gifts-full.js", renderGiftsModule(outcome.gifts, amazonPricesCheckedOn));
writeFileSync(ignorePath, `${JSON.stringify(outcome.ignore, null, 2)}\n`);
if (outcome.deleteImage) rmSync(root + outcome.deleteImage, { force: true });
console.log(outcome.message);
