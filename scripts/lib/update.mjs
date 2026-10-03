import { formatAed, parseAed } from "./html.mjs";

// Applies freshly scraped Amazon prices to the gift list. A price that moved by more than `maxChange`
// is held back for the host to look at: Amazon sometimes shows a different offer depending on where
// the page is fetched from, and a wrong price on the site is worse than a stale one.
export function applyAmazonPrices(gifts, scraped, { maxChange = 0.25, acknowledged = new Set() } = {}) {
  if (!scraped.length || scraped.length < gifts.length * 0.8) {
    throw new Error(`Wishlist scrape looks incomplete (${scraped.length} items for ${gifts.length} gifts); nothing changed.`);
  }

  const byAsin = new Map(scraped.map((item) => [item.asin, item]));
  const report = { applied: [], held: [], acknowledged: 0, unchanged: 0, missing: [], added: [], boughtOnAmazon: [] };

  const next = gifts.map((gift) => {
    const item = byAsin.get(gift.id);
    if (!item) {
      report.missing.push({ id: gift.id, name: gift.name });
      return gift;
    }
    if (item.purchased > 0) report.boughtOnAmazon.push({ id: gift.id, name: gift.name, count: item.purchased });

    const from = parseAed(gift.price);
    const to = item.price;
    if (!Number.isFinite(to) || to <= 0 || (from !== null && Math.abs(to - from) < 0.005)) {
      report.unchanged += 1;
      return gift;
    }
    if (from !== null && Math.abs(to - from) / from > maxChange) {
      // Items the host has already looked at keep their price and stay quiet.
      if (acknowledged.has(gift.id)) report.acknowledged += 1;
      else report.held.push({ id: gift.id, name: gift.name, from, to });
      return gift;
    }
    report.applied.push({ id: gift.id, name: gift.name, from, to });
    return { ...gift, price: formatAed(to) };
  });

  const known = new Set(gifts.map((gift) => gift.id));
  report.added = scraped.filter((item) => !known.has(item.asin)).map((item) => ({ id: item.asin, name: item.name, price: item.price }));
  return { gifts: next, report };
}

export function renderGiftsModule(gifts, amazonPricesCheckedOn) {
  return `// Amazon prices are snapshots from the wishlist on this date; the site shows it in the footer.
export const amazonPricesCheckedOn = ${JSON.stringify(amazonPricesCheckedOn)};

export const gifts = ${JSON.stringify(gifts, null, 2)};
`;
}

const money = (value) => `AED ${Number(value).toFixed(2)}`;
const short = (text, length = 60) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function renderReport({ today, amazon, amazonError, wrote }) {
  const lines = [`# Price update, ${today}`, ""];
  const section = (title, rows) => { if (rows.length) lines.push(`## ${title}`, ...rows, ""); };

  if (amazonError) section("Amazon step FAILED, nothing changed", [`- ${amazonError}`]);
  if (amazon) {
    lines.push(`Amazon: ${amazon.applied.length} updated, ${amazon.unchanged} unchanged, ${amazon.held.length} held for review${amazon.acknowledged ? `, ${amazon.acknowledged} already acknowledged in scripts/held-ignore.json` : ""}.`, "");
    section("Amazon prices updated", amazon.applied.map((r) => `- ${short(r.name)}: ${r.from === null ? "n/a" : money(r.from)} to ${money(r.to)}`));
    section("HELD FOR REVIEW (moved more than 25%, not applied)", amazon.held.map((r) => `- ${short(r.name)} (${r.id}): ${money(r.from)} on the site, ${money(r.to)} on Amazon now`));
    section("Wishlist items not found on Amazon (not removed from the site)", amazon.missing.map((r) => `- ${short(r.name)} (${r.id})`));
    section("New on the Amazon wishlist (not added to the site)", amazon.added.map((r) => `- ${short(r.name ?? r.id)} (${r.id})${r.price ? ` ${money(r.price)}` : ""}`));
    section("Bought on Amazon from the wishlist", amazon.boughtOnAmazon.map((r) => `- ${short(r.name)} (${r.id}): ${r.count}`));
  }

  lines.push(wrote ? "File updated: public/gifts-full.js" : "No files were written.");
  return lines.join("\n");
}
