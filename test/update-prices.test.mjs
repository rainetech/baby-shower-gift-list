import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fetchWishlist, isBotCheck, nextPageUrl, parseWishlistPage } from "../scripts/lib/amazon.mjs";
import { decodeEntities, formatAed, parseAed } from "../scripts/lib/html.mjs";
import { applyAmazonPrices, renderGiftsModule } from "../scripts/lib/update.mjs";

const wishlistPage = readFileSync(new URL("./fixtures/wishlist-page.html", import.meta.url), "utf8");
const importSource = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const gift = (id, price, name = `Gift ${id}`) => ({ id, name, price, image: `assets/${id}.jpg`, amazonUrl: `https://www.amazon.ae/dp/${id}/` });
const scraped = (asin, price, extra = {}) => ({ itemId: `I${asin}`, asin, name: `Gift ${asin}`, price, purchased: 0, ...extra });

describe("helpers", () => {
  it("decodes entities and parses AED amounts", () => {
    assert.equal(decodeEntities("Bumble &amp; Bird &#39;x&#39; &#x2122; &nbsp;&unknown;"), "Bumble & Bird 'x' ™  &unknown;");
    assert.equal(parseAed("AED 1,299.50"), 1299.5);
    assert.equal(parseAed("See Amazon"), null);
    assert.equal(formatAed(76.5), "AED 76.50");
  });
});

describe("Amazon wishlist parsing", () => {
  it("reads asin, name and the displayed price from real markup", () => {
    const items = parseWishlistPage(wishlistPage);
    assert.deepEqual(items.map((i) => [i.asin, i.price, i.purchased]), [["B0C65Z31KS", 139, 0], ["B001ABZGU2", 29, 0], ["B09Y8WYDQF", 37.89, 0]]);
    assert.match(items[0].name, /^Bumble & Bird - Diaper Pail/);
  });

  it("finds the next-page url and decodes it", () => {
    const next = nextPageUrl(wishlistPage);
    assert.match(next, /^\/hz\/wishlist\/slv\/items\?filter=unpurchased&paginationToken=/);
    assert.ok(!next.includes("&amp;"));
    assert.equal(nextPageUrl("<html></html>"), null);
  });

  it("pages until there is nothing new and drops repeats", async () => {
    const fragment = (...ids) => ids.map((id) => `<li data-id="8NAFD2SAPMH" data-itemId="I${id}" data-price="10.0" data-reposition-action-params="{&quot;itemExternalId&quot;:&quot;ASIN:${id.padEnd(10, "0")}|X&quot;}"><span id="itemPrice_I${id}"><span class="a-offscreen">AED 10.00</span></span></li>`).join("");
    const pages = [
      `<input name="showMoreUrl" value="/more?p=2&amp;lid=8NAFD2SAPMH" class="showMoreUrl"/>${fragment("A1", "A2")}`,
      `<input name="showMoreUrl" value="/more?p=3&amp;lid=8NAFD2SAPMH" class="showMoreUrl"/>${fragment("A2", "A3")}`,
      `${fragment("A2", "A3")}`
    ];
    const requested = [];
    const items = await fetchWishlist(async (url) => { requested.push(url); return pages[requested.length - 1]; });
    assert.deepEqual(items.map((i) => i.itemId), ["IA1", "IA2", "IA3"]);
    assert.match(requested[1], /^https:\/\/www\.amazon\.ae\/more\?p=2&lid=8NAFD2SAPMH&ajax=true&viewType=list$/);
  });

  it("refuses to carry on when Amazon serves a bot check", async () => {
    assert.ok(isBotCheck("<h4>Enter the characters you see below</h4>"));
    await assert.rejects(fetchWishlist(async () => "<form action='/errors/validateCaptcha'>"), /bot check/);
  });
});

describe("applyAmazonPrices", () => {
  const gifts = [gift("A", "AED 100.00"), gift("B", "AED 50.00"), gift("C", "AED 20.00"), gift("D", "AED 10.00"), gift("E", "AED 10.00")];

  it("applies normal moves and holds big jumps for review", () => {
    const { gifts: next, report } = applyAmazonPrices(gifts, [scraped("A", 110), scraped("B", 91.25), scraped("C", 20), scraped("D", 10), scraped("E", 10)]);
    assert.deepEqual(next.map((g) => g.price), ["AED 110.00", "AED 50.00", "AED 20.00", "AED 10.00", "AED 10.00"]);
    assert.deepEqual(report.applied.map((r) => r.id), ["A"]);
    assert.deepEqual(report.held.map((r) => [r.id, r.from, r.to]), [["B", 50, 91.25]]);
    assert.equal(report.unchanged, 3);
  });

  it("keeps quiet about big moves the host has already acknowledged, and still keeps the old price", () => {
    const { gifts: next, report } = applyAmazonPrices(gifts, [scraped("A", 100), scraped("B", 91.25), scraped("C", 40), scraped("D", 10), scraped("E", 10)], { acknowledged: new Set(["B"]) });
    assert.equal(next[1].price, "AED 50.00");
    assert.deepEqual(report.held.map((r) => r.id), ["C"]);
    assert.equal(report.acknowledged, 1);
  });

  it("does not keep reporting a wishlist item the host chose to leave off the site", () => {
    const scrape = [scraped("A", 100), scraped("B", 50), scraped("C", 20), scraped("D", 10), scraped("E", 10), scraped("Z", 5)];
    assert.deepEqual(applyAmazonPrices(gifts, scrape).report.added.map((r) => r.id), ["Z"]);
    assert.deepEqual(applyAmazonPrices(gifts, scrape, { acknowledged: new Set(["Z"]) }).report.added, []);
  });

  it("only ever changes the price field", () => {
    const { gifts: next } = applyAmazonPrices(gifts, [scraped("A", 110), scraped("B", 55), scraped("C", 21), scraped("D", 11), scraped("E", 9)]);
    next.forEach((g, i) => assert.deepEqual({ ...g, price: null }, { ...gifts[i], price: null }));
    assert.equal(next.length, gifts.length);
  });

  it("does not touch gifts missing from the scrape, and reports additions and Amazon purchases", () => {
    const { gifts: next, report } = applyAmazonPrices(gifts, [scraped("A", 100, { purchased: 1 }), scraped("B", 50), scraped("C", 20), scraped("D", 10), scraped("Z", 5)]);
    assert.equal(next[4].price, "AED 10.00");
    assert.deepEqual(report.missing.map((r) => r.id), ["E"]);
    assert.deepEqual(report.added.map((r) => r.id), ["Z"]);
    assert.deepEqual(report.boughtOnAmazon.map((r) => [r.id, r.count]), [["A", 1]]);
  });

  it("ignores unreadable scraped prices and prices a 'See Amazon' gift", () => {
    const { gifts: next } = applyAmazonPrices([...gifts.slice(0, 4), gift("E", "See Amazon")], [scraped("A", null), scraped("B", 50), scraped("C", 20), scraped("D", 10), scraped("E", 12)]);
    assert.equal(next[0].price, "AED 100.00");
    assert.equal(next[4].price, "AED 12.00");
  });

  it("aborts instead of wiping prices when the scrape is incomplete", () => {
    assert.throws(() => applyAmazonPrices(gifts, [scraped("A", 1)]), /incomplete/);
    assert.throws(() => applyAmazonPrices(gifts, []), /incomplete/);
  });
});

describe("rendered data files", () => {
  it("round-trips the gift list and carries the Amazon check date", async () => {
    const gifts = [gift("A", "AED 10.00"), gift("B", "AED 20.00")];
    const mod = await importSource(renderGiftsModule(gifts, "3 Oct 2026"));
    assert.deepEqual(mod.gifts, gifts);
    assert.equal(mod.amazonPricesCheckedOn, "3 Oct 2026");
  });
});
