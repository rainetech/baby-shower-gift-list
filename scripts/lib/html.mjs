const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function textOf(fragment) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function parseAed(label) {
  const match = /[\d,]+(?:\.\d+)?/.exec(label ?? "");
  return match ? Number(match[0].replaceAll(",", "")) : null;
}

export const formatAed = (value) => `AED ${Number(value).toFixed(2)}`;
