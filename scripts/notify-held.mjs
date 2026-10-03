#!/usr/bin/env node
// Sends a WhatsApp message (through CallMeBot) for each big price jump that hasn't been messaged yet.
//
//   CALLMEBOT_RECIPIENTS="+971...:key" NOTIFIED="B0AAA,B0BBB" GITHUB_REPOSITORY=owner/repo \
//     node scripts/notify-held.mjs price-report.json
//
// Prints Markdown for the price-review issue, ending with a hidden "notified" marker that the next
// run reads back so the same gift isn't messaged twice. Always exits 0: a messaging problem must not
// stop the price update.
import { readFileSync } from "node:fs";
import { notifyHeld, parseRecipients, renderNotifyReport } from "./lib/notify.mjs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = await notifyHeld({
  held: report.held ?? [],
  recipients: parseRecipients(process.env.CALLMEBOT_RECIPIENTS),
  alreadyNotified: (process.env.NOTIFIED ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  repository: process.env.GITHUB_REPOSITORY ?? "rainetech/baby-shower-gift-list"
});
console.log(renderNotifyReport(result));
