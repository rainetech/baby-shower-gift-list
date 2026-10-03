import { formatAed } from "./html.mjs";

const short = (text, length = 70) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// Only these two exact titles are understood, for example "Remove gift B0C65Z31KS" or
// "Keep gift B0C65Z31KS at AED 37.21".
export function parseDecisionTitle(title) {
  const match = /^(Remove|Keep) gift (B[0-9A-Z]{9})(?: at AED ([0-9]{1,5}\.[0-9]{2}))?$/.exec(String(title ?? "").trim());
  if (!match) return null;
  const [, verb, id, price] = match;
  if (verb === "Keep" ? !price : price) return null;
  return { action: verb.toLowerCase(), id, price: price ? Number(price) : null };
}

// Returns { ok, message, gifts, ignore, deleteImage }. Nothing is changed unless ok is true. A gift
// a guest has already reserved is never removed or repriced.
export function applyDecision(gifts, ignore, decision, { reserved }) {
  const refuse = (message) => ({ ok: false, message, gifts, ignore, deleteImage: null });
  const gift = gifts.find((candidate) => candidate.id === decision.id);
  if (!gift) return refuse(`${decision.id} is not on the list, so nothing was changed.`);
  if (reserved.has(decision.id)) return refuse(`${decision.id} (${short(gift.name)}) has already been reserved by a guest, so nothing was changed.`);

  if (decision.action === "remove") {
    return {
      ok: true,
      message: `Removed from the list: ${short(gift.name)} (${gift.id}). It stays on the Amazon wishlist, and the morning check will not report it as new.`,
      gifts: gifts.filter((candidate) => candidate.id !== decision.id),
      ignore: ignore.includes(decision.id) ? ignore : [...ignore, decision.id],
      deleteImage: gift.image
    };
  }

  if (!(decision.price > 0)) return refuse(`${decision.price} is not a usable price, so nothing was changed.`);
  return {
    ok: true,
    message: `Kept on the list at the new price: ${short(gift.name)} (${gift.id}) is now ${formatAed(decision.price)}.`,
    gifts: gifts.map((candidate) => (candidate.id === decision.id ? { ...candidate, price: formatAed(decision.price) } : candidate)),
    ignore,
    deleteImage: null
  };
}
