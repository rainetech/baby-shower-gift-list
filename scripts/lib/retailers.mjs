import { decodeEntities } from "./html.mjs";

const IN_STOCK = /InStock|LimitedAvailability|OnlineOnly|InStoreOnly/i;
const OUT_OF_STOCK = /OutOfStock|SoldOut|Discontinued/i;

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (node && typeof node === "object") {
    yield node;
    for (const child of Object.values(node)) if (child && typeof child === "object") yield* walk(child);
  }
}

const isProduct = (node) => [].concat(node["@type"] ?? []).some((type) => /^Product$/i.test(String(type)));

function readJsonLd(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let data;
    try { data = JSON.parse(body); } catch { continue; }
    for (const node of walk(data)) {
      if (!isProduct(node)) continue;
      for (const offer of [].concat(node.offers ?? [])) {
        const price = Number(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price);
        const currency = offer.priceCurrency ?? offer.priceSpecification?.priceCurrency;
        if (!Number.isFinite(price) || price <= 0 || (currency && currency !== "AED")) continue;
        const availability = String(offer.availability ?? "");
        const inStock = OUT_OF_STOCK.test(availability) ? false : IN_STOCK.test(availability) ? true : null;
        return { value: price, inStock, source: "json-ld" };
      }
    }
  }
  return null;
}

// FirstCry puts its price in #a_price and a quantity in the script data ("pid":"<id>","qty":N), but
// whether the product can be bought is decided by the live page. Checked against the live pages: a
// quantity above 0 always meant in stock, while 0 appeared both on a sold-out product and on several
// that could be bought. So 0 is reported as unknown stock (null), never as sold out.
function readFirstCry(html, url) {
  const pid = /\/([a-z0-9]+)\/product-detail/i.exec(url)?.[1];
  const price = Number(/id=['"]a_price['"][^>]*>\s*([\d,.]+)\s*</i.exec(html)?.[1]?.replaceAll(",", ""));
  const qty = pid ? new RegExp(`"pid":"${pid}","qty":(\\d+)`).exec(html)?.[1] : undefined;
  if (!Number.isFinite(price) || price <= 0 || qty === undefined) return null;
  return { value: price, inStock: Number(qty) > 0 ? true : null, source: "firstcry" };
}

function readMeta(html) {
  const meta = (name) => new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)?.[1]
    ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i").exec(html)?.[1];
  const price = Number(meta("product:price:amount") ?? meta("og:price:amount"));
  const currency = meta("product:price:currency") ?? meta("og:price:currency");
  if (!Number.isFinite(price) || price <= 0 || (currency && currency !== "AED")) return null;
  const availability = decodeEntities(meta("product:availability") ?? meta("og:availability") ?? "");
  const inStock = /out of stock|oos/i.test(availability) ? false : /in stock|instock/i.test(availability) ? true : null;
  return { value: price, inStock, source: "meta" };
}

// Returns { value, inStock, source }, or null when the page doesn't expose a trustworthy price.
// inStock is null when the page gives a price but no reliable stock signal.
export function extractOffer(html, url) {
  const host = new URL(url).hostname;
  if (/firstcry\./i.test(host)) return readFirstCry(html, url);
  return readJsonLd(html) ?? readMeta(html);
}
