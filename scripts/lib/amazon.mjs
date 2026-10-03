import { decodeEntities, parseAed, textOf } from "./html.mjs";

export const WISHLIST_ID = "8NAFD2SAPMH";
const BASE = "https://www.amazon.ae";

export const isBotCheck = (html) => /validateCaptcha|Type the characters you see|Enter the characters you see/i.test(html);

// Reads the items on one page (or ajax fragment) of the wishlist.
export function parseWishlistPage(html) {
  const items = [];
  const itemStart = new RegExp(`<li\\s+data-id="${WISHLIST_ID}"\\s+data-itemId="([A-Z0-9]+)"`, "g");

  for (const match of html.matchAll(itemStart)) {
    const itemId = match[1];
    const end = html.indexOf("</li>", match.index);
    const block = html.slice(match.index, end === -1 ? undefined : end);
    const head = block.slice(0, block.indexOf(">"));
    const asin = /ASIN:([A-Z0-9]{10})/.exec(decodeEntities(head))?.[1];
    if (!asin) continue;

    const shown = new RegExp(`id="itemPrice_${itemId}"[\\s\\S]*?<span class="a-offscreen">([^<]*)</span>`).exec(block)?.[1];
    const dataPrice = /data-price="([^"]*)"/.exec(head)?.[1];
    const purchased = new RegExp(`id="itemPurchased_${itemId}"[^>]*>([\\s\\S]*?)</span>`).exec(block)?.[1];
    const name = new RegExp(`id="itemName_${itemId}"[^>]*title="([^"]*)"`).exec(block)?.[1];

    items.push({
      itemId,
      asin,
      name: name ? decodeEntities(name) : null,
      price: parseAed(shown) ?? parseAed(dataPrice),
      purchased: Number(textOf(purchased ?? "0")) || 0
    });
  }
  return items;
}

export function nextPageUrl(html) {
  const match = /name="showMoreUrl"\s+value="([^"]*)"/.exec(html)
    ?? /value="([^"]*)"\s+class="showMoreUrl"/.exec(html)
    ?? /showMoreUrl"\s*:\s*"([^"]*)"/.exec(html);
  return match ? decodeEntities(match[1]).replaceAll("\\u0026", "&") : null;
}

// `get(url)` resolves to the response body text.
export async function fetchWishlist(get, { maxPages = 40 } = {}) {
  let page = await get(`${BASE}/hz/wishlist/ls/${WISHLIST_ID}?viewType=list&filter=all&sort=date-added`);
  if (isBotCheck(page)) throw new Error("Amazon served a bot check instead of the wishlist");

  const items = parseWishlistPage(page);
  const seen = new Set(items.map((item) => item.itemId));

  for (let pageNumber = 2; pageNumber <= maxPages; pageNumber += 1) {
    const next = nextPageUrl(page);
    if (!next) break;
    page = await get(`${BASE}${next}&ajax=true&viewType=list`);
    if (isBotCheck(page)) throw new Error("Amazon served a bot check while paging the wishlist");
    const fresh = parseWishlistPage(page).filter((item) => !seen.has(item.itemId));
    if (!fresh.length) break;
    fresh.forEach((item) => seen.add(item.itemId));
    items.push(...fresh);
  }
  return items;
}
