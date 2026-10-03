import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fetchWishlist, isBotCheck, nextPageUrl, parseWishlistPage } from "../scripts/lib/amazon.mjs";
import { decodeEntities, formatAed, parseAed } from "../scripts/lib/html.mjs";
import { extractOffer } from "../scripts/lib/retailers.mjs";
import { applyAmazonPrices, applyRetailerChecks, renderAlternativesModule, renderGiftsModule } from "../scripts/lib/update.mjs";

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

describe("extractOffer", () => {
  const ld = (offers, extra = {}) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "X", offers, ...extra })}</script>`;
  const url = "https://www.example.ae/p/1";

  it("reads price and stock from JSON-LD, including arrays, @graph and AggregateOffer", () => {
    assert.deepEqual(extractOffer(ld({ price: "155.00", priceCurrency: "AED", availability: "https://schema.org/InStock" }), url), { value: 155, inStock: true, source: "json-ld" });
    assert.equal(extractOffer(ld([{ price: 9, priceCurrency: "AED", availability: "https://schema.org/OutOfStock" }]), url).inStock, false);
    assert.equal(extractOffer(ld({ "@type": "AggregateOffer", lowPrice: 7.5, priceCurrency: "AED" }), url).value, 7.5);
    const graph = `<script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Organization" }, { "@type": ["Thing", "Product"], offers: { price: 12, priceCurrency: "AED", availability: "InStock" } }] })}</script>`;
    assert.equal(extractOffer(graph, url).value, 12);
  });

  it("reports unknown stock as null, and rejects other currencies and missing prices", () => {
    assert.equal(extractOffer(ld({ price: 20, priceCurrency: "AED" }), url).inStock, null);
    assert.equal(extractOffer(ld({ price: 20, priceCurrency: "USD", availability: "InStock" }), url), null);
    assert.equal(extractOffer(ld({ priceCurrency: "AED" }), url), null);
    assert.equal(extractOffer("<html>no data</html>", url), null);
    assert.equal(extractOffer(`<script type="application/ld+json">{not json</script>`, url), null);
  });

  it("falls back to product meta tags", () => {
    const html = `<meta property="product:price:amount" content="33.50"><meta property="product:price:currency" content="AED"><meta property="product:availability" content="out of stock">`;
    assert.deepEqual(extractOffer(html, url), { value: 33.5, inStock: false, source: "meta" });
  });

  it("reads FirstCry price and the stock quantity for the page's own product only", () => {
    const fc = (qty) => `<span id='a_price' class="B24_42">1,100.04</span> "pid":"c7509ae5d6c12","qty":9,"x":1} {"pid":"dfa68aec1f8e6","qty":${qty},"sz":"Size 2"`;
    const page = "https://www.firstcry.ae/pampers/pampers-size-2/dfa68aec1f8e6/product-detail";
    assert.deepEqual(extractOffer(fc(108), page), { value: 1100.04, inStock: true, source: "firstcry" });
    assert.equal(extractOffer(fc(0), page).inStock, null); // 0 is ambiguous on FirstCry, so never "sold out"
    assert.equal(extractOffer("<span id='a_price'>5</span>", page), null);
  });
});

describe("applyRetailerChecks", () => {
  const offer = (retailer, value, extra = {}) => ({ retailer, price: formatAed(value), value, url: `https://${retailer.toLowerCase()}.example/${value}`, ...extra });
  const ok = (value, inStock = true) => ({ ok: true, value, inStock });
  const input = () => ({
    priceCheckDate: "30 Aug 2026",
    alternativePrices: {
      G1: [offer("Mumz", 80), offer("Noon", 82, { checked: "30 Aug 2026" }), { retailer: "Link", url: "https://link.example/x" }],
      G2: [offer("Mumz", 10)]
    }
  });
  const today = "3 Oct 2026";

  it("refreshes prices, clears old dates, and reports changes", () => {
    const checks = new Map([["https://mumz.example/80", ok(75)], ["https://noon.example/82", ok(82)]]);
    const { alternatives, report } = applyRetailerChecks(input(), checks, { today });
    assert.equal(alternatives.priceCheckDate, today);
    assert.deepEqual(alternatives.alternativePrices.G1[0], { retailer: "Mumz", price: "AED 75.00", value: 75, url: "https://mumz.example/80" });
    assert.equal(alternatives.alternativePrices.G1[1].checked, undefined);
    assert.deepEqual(report.refreshed.map((r) => [r.retailer, r.from, r.to]), [["Mumz", 80, 75]]);
    assert.equal(report.unchanged, 1);
  });

  it("dates offers it could not re-check, but only when something else was verified", () => {
    const partial = applyRetailerChecks(input(), new Map([["https://noon.example/82", ok(82)]]), { today });
    assert.equal(partial.alternatives.priceCheckDate, today);
    assert.equal(partial.alternatives.alternativePrices.G1[0].checked, "30 Aug 2026"); // Mumz was current, now stale
    assert.equal(partial.alternatives.alternativePrices.G1[1].checked, undefined);     // Noon re-verified
    assert.equal(partial.alternatives.alternativePrices.G1[2].checked, undefined);     // link-only offers have no price to date

    const nothing = applyRetailerChecks(input(), new Map(), { today });
    assert.equal(nothing.alternatives.priceCheckDate, "30 Aug 2026");
    assert.deepEqual(nothing.alternatives.alternativePrices, input().alternativePrices);
    assert.equal(nothing.report.unverified.length, 4);
    assert.equal(applyRetailerChecks(input(), new Map([["https://mumz.example/80", { ok: false, reason: "HTTP 403" }]]), { today }).alternatives.priceCheckDate, "30 Aug 2026");
  });

  it("does not move the date when run twice on the same day", () => {
    const first = applyRetailerChecks(input(), new Map([["https://mumz.example/80", ok(80)]]), { today });
    const second = applyRetailerChecks(first.alternatives, new Map([["https://mumz.example/80", ok(80)]]), { today });
    assert.deepEqual(second.alternatives.alternativePrices.G1[1], first.alternatives.alternativePrices.G1[1]);
  });

  it("flags sold-out offers instead of deleting them, and restores them when back", () => {
    const sold = applyRetailerChecks(input(), new Map([["https://mumz.example/10", ok(10, false)]]), { today });
    assert.equal(sold.alternatives.alternativePrices.G2[0].soldOut, true);
    assert.equal(sold.report.soldOut.length, 1);

    const back = applyRetailerChecks(sold.alternatives, new Map([["https://mumz.example/10", ok(11)]]), { today });
    assert.equal(back.alternatives.alternativePrices.G2[0].soldOut, undefined);
    assert.equal(back.alternatives.alternativePrices.G2[0].value, 11);
    assert.equal(back.report.backInStock.length, 1);
  });

  it("holds moves of more than 40%", () => {
    const { alternatives, report } = applyRetailerChecks(input(), new Map([["https://mumz.example/10", ok(30)]]), { today });
    assert.equal(alternatives.alternativePrices.G2[0].value, 10);
    assert.deepEqual(report.held.map((r) => [r.from, r.to]), [[10, 30]]);
  });

  it("refreshes the price when stock is unknown but leaves the sold-out flag alone", () => {
    const live = applyRetailerChecks(input(), new Map([["https://mumz.example/10", ok(11, null)]]), { today });
    assert.deepEqual(live.alternatives.alternativePrices.G2[0], { retailer: "Mumz", price: "AED 11.00", value: 11, url: "https://mumz.example/10" });

    const hidden = { priceCheckDate: "30 Aug 2026", alternativePrices: { G2: [offer("Mumz", 10, { soldOut: true })] } };
    const still = applyRetailerChecks(hidden, new Map([["https://mumz.example/10", ok(12, null)]]), { today });
    assert.equal(still.alternatives.alternativePrices.G2[0].soldOut, true);
    assert.equal(still.alternatives.alternativePrices.G2[0].value, 12);
    assert.equal(still.report.backInStock.length, 0);
  });

  it("gives a link-only offer a price once it can be read", () => {
    const { alternatives, report } = applyRetailerChecks(input(), new Map([["https://link.example/x", ok(44)]]), { today });
    assert.deepEqual(alternatives.alternativePrices.G1[2], { retailer: "Link", price: "AED 44.00", value: 44, url: "https://link.example/x" });
    assert.equal(report.upgraded.length, 1);
  });
});

describe("rendered data files", () => {
  it("round-trips the gift list and carries the Amazon check date", async () => {
    const gifts = [gift("A", "AED 10.00"), gift("B", "AED 20.00")];
    const mod = await importSource(renderGiftsModule(gifts, "3 Oct 2026"));
    assert.deepEqual(mod.gifts, gifts);
    assert.equal(mod.amazonPricesCheckedOn, "3 Oct 2026");
  });

  it("round-trips offers, orders them cheapest first with link-only last, and keeps flags", async () => {
    const data = {
      priceCheckDate: "3 Oct 2026",
      alternativePrices: {
        A: [{ retailer: "Link", url: "https://l.example/" }, { retailer: "High", price: "AED 50.00", value: 50, url: "https://h.example/" },
          { retailer: "Low", price: "AED 20.00", value: 20, url: "https://lo.example/", checked: "30 Aug 2026", soldOut: true }],
        GONE: [{ retailer: "X", price: "AED 1.00", value: 1, url: "https://x.example/" }]
      }
    };
    const mod = await importSource(renderAlternativesModule(data, [gift("A", "AED 10.00")]));
    assert.equal(mod.priceCheckDate, "3 Oct 2026");
    assert.deepEqual(Object.keys(mod.alternativePrices), ["A"]);
    assert.deepEqual(mod.alternativePrices.A.map((o) => o.retailer), ["Low", "High", "Link"]);
    assert.equal(mod.alternativePrices.A[0].soldOut, true);
    assert.equal(mod.alternativePrices.A[0].checked, "30 Aug 2026");
    assert.equal(mod.alternativePrices.A[2].price, undefined);
  });
});
