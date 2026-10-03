import { formatAed, parseAed } from "./html.mjs";

const round2 = (value) => Number(Number(value).toFixed(2));

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

// `checks` maps a retailer URL to { ok, value, inStock } from extractOffer, or { ok: false, reason }.
// A readable price refreshes the offer. inStock true clears a sold-out flag, false sets it (the site
// hides sold-out offers but they stay in the data so they can come back), and null (stock unknown)
// leaves the flag as it was. Offers whose price can't be read keep their old price and are dated.
export function applyRetailerChecks({ priceCheckDate, alternativePrices }, checks, { today, maxChange = 0.4 }) {
  const report = { refreshed: [], unchanged: 0, soldOut: [], backInStock: [], held: [], unverified: [], upgraded: [] };
  const anyRead = [...checks.values()].some((check) => check?.ok);
  const label = (id, offer) => ({ id, retailer: offer.retailer, url: offer.url });

  const next = {};
  for (const [id, offers] of Object.entries(alternativePrices)) {
    next[id] = offers.map((offer) => {
      const check = checks.get(offer.url);
      const wasCurrent = !offer.checked || offer.checked === priceCheckDate;
      const stale = () => (offer.value != null && wasCurrent && anyRead && priceCheckDate !== today
        ? { ...offer, checked: priceCheckDate } : offer);

      if (!check?.ok) {
        report.unverified.push({ ...label(id, offer), reason: check?.reason ?? "no price found on the page" });
        return stale();
      }
      if (check.inStock === false) {
        if (!offer.soldOut) report.soldOut.push(label(id, offer));
        return { ...stale(), soldOut: true };
      }
      if (offer.value != null && Math.abs(check.value - offer.value) / offer.value > maxChange) {
        report.held.push({ ...label(id, offer), from: offer.value, to: check.value });
        return stale();
      }

      const soldOut = check.inStock === true ? false : Boolean(offer.soldOut);
      if (offer.soldOut && !soldOut) report.backInStock.push(label(id, offer));
      if (offer.value == null) report.upgraded.push({ ...label(id, offer), to: check.value });
      else if (Math.abs(check.value - offer.value) < 0.005) report.unchanged += 1;
      else report.refreshed.push({ ...label(id, offer), from: offer.value, to: check.value });
      return { retailer: offer.retailer, price: formatAed(check.value), value: round2(check.value), url: offer.url, ...(soldOut ? { soldOut: true } : {}) };
    });
  }

  return {
    alternatives: { priceCheckDate: anyRead ? today : priceCheckDate, alternativePrices: next },
    report
  };
}

export function renderGiftsModule(gifts, amazonPricesCheckedOn) {
  return `// Amazon prices are snapshots from the wishlist on this date; the site shows it in the footer.
export const amazonPricesCheckedOn = ${JSON.stringify(amazonPricesCheckedOn)};

export const gifts = ${JSON.stringify(gifts, null, 2)};
`;
}

const offerLine = (offer) => {
  const parts = [`retailer: ${JSON.stringify(offer.retailer)}`];
  if (offer.price != null) parts.push(`price: ${JSON.stringify(offer.price)}`, `value: ${offer.value}`);
  parts.push(`url: ${JSON.stringify(offer.url)}`);
  if (offer.checked) parts.push(`checked: ${JSON.stringify(offer.checked)}`);
  if (offer.soldOut) parts.push("soldOut: true");
  return `    { ${parts.join(", ")} }`;
};

export function renderAlternativesModule({ priceCheckDate, alternativePrices }, gifts) {
  const body = gifts
    .filter((gift) => alternativePrices[gift.id]?.length)
    .map((gift) => {
      // Priced offers first (cheapest first); link-only offers after them.
      const offers = [...alternativePrices[gift.id]].sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));
      return `  ${gift.id}: [\n${offers.map(offerLine).join(",\n")}\n  ]`;
    })
    .join(",\n");

  return `// Other UAE retailers selling the exact same product (same brand, model, colour and pack size).
// Prices are snapshots and may change at checkout. An offer without \`checked\` was verified on
// \`priceCheckDate\`; an offer with \`checked\` is an older snapshot that could not be re-checked.
// An offer with no price is a link only (price not checked). \`soldOut\` offers are hidden on the site.
export const priceCheckDate = ${JSON.stringify(priceCheckDate)};

export const alternativePrices = {
${body}
};
`;
}

const money = (value) => `AED ${Number(value).toFixed(2)}`;
const short = (text, length = 60) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function renderReport({ today, amazon, amazonError, retailers, retailerError, wrote }) {
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

  if (retailerError) section("Retailer step FAILED, nothing changed", [`- ${retailerError}`]);
  if (retailers) {
    lines.push(`Retailers: ${retailers.refreshed.length} refreshed, ${retailers.unchanged} unchanged, ${retailers.unverified.length} could not be re-checked, ${retailers.held.length} held, ${retailers.soldOut.length} newly sold out.`, "");
    section("Retailer prices refreshed", retailers.refreshed.map((r) => `- ${r.retailer} ${r.id}: ${money(r.from)} to ${money(r.to)}`));
    section("Link-only offers now priced", retailers.upgraded.map((r) => `- ${r.retailer} ${r.id}: ${money(r.to)}`));
    section("Newly sold out (hidden on the site)", retailers.soldOut.map((r) => `- ${r.retailer} ${r.id}`));
    section("Back in stock", retailers.backInStock.map((r) => `- ${r.retailer} ${r.id}`));
    section("HELD FOR REVIEW (moved more than 40%, not applied)", retailers.held.map((r) => `- ${r.retailer} ${r.id}: ${money(r.from)} on the site, ${money(r.to)} now`));
    section("Could not be re-checked (kept, dated)", retailers.unverified.map((r) => `- ${r.retailer} ${r.id}: ${r.reason}`));
  }

  lines.push(wrote ? "Files updated: public/gifts-full.js, public/alternative-prices.js" : "No files were written.");
  return lines.join("\n");
}
