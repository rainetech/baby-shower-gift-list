import { formatAed } from "./html.mjs";

const MAX_MESSAGES_PER_RUN = 5;
const short = (text, length = 80) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// "+9715XXXXXXXX:apikey,+9715YYYYYYYY:apikey" -> [{ phone, key }]. CallMeBot gives each person their
// own key when they message its WhatsApp number once.
export function parseRecipients(value = "") {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const index = entry.lastIndexOf(":");
    if (index < 1) return null; // no "phone:key" separator
    return { phone: entry.slice(0, index).trim(), key: entry.slice(index + 1).trim() };
  }).filter((recipient) => recipient?.phone && recipient.key);
}

// Links that open a pre-filled GitHub issue. Tapping "Submit new issue" is what triggers the change
// (see .github/workflows/gift-decision.yml), and only the owner and collaborators can trigger it.
export function decisionLinks(repository, held) {
  const base = `https://github.com/${repository}/issues/new`;
  const link = (title) => `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent("Created from a price alert. Press Submit new issue to apply.")}`;
  return {
    remove: link(`Remove gift ${held.id}`),
    keep: link(`Keep gift ${held.id} at ${formatAed(held.to)}`)
  };
}

export function formatMessage(repository, held) {
  const change = Math.round(((held.to - held.from) / held.from) * 100);
  const links = decisionLinks(repository, held);
  return [
    "Gift list price alert",
    "",
    short(held.name),
    `${formatAed(held.from)} on the site, ${formatAed(held.to)} on Amazon now (${change > 0 ? "+" : ""}${change}%).`,
    "Amazon can show a different price outside the UAE, so check the link first:",
    `https://www.amazon.ae/dp/${held.id}/`,
    "",
    "Remove it from the list:",
    links.remove,
    "",
    `Keep it at ${formatAed(held.to)}:`,
    links.keep,
    "",
    "If you do nothing, the site keeps the old price."
  ].join("\n");
}

function redact(text, secrets) {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join("***"), text);
}

// Sends one WhatsApp message through CallMeBot. Resolves { ok, detail } and never throws, and never
// returns the phone number or key.
export async function sendWhatsApp({ phone, key }, text, fetchImpl = fetch) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    const failed = !response.ok || /\berror\b|invalid|not allowed|wrong/i.test(body);
    return { ok: !failed, detail: failed ? redact(`HTTP ${response.status}: ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)}`, [phone, key, encodeURIComponent(phone)]) : "sent" };
  } catch (error) {
    return { ok: false, detail: redact(error.message, [phone, key]) };
  }
}

// Messages every recipient about each held price that hasn't been messaged yet. `alreadyNotified` is
// the list from the previous run, so a gift that stays held is only messaged once. Returns the new
// list (gifts that are still held and were messaged), plus what happened.
export async function notifyHeld({ held, recipients, alreadyNotified = [], repository, fetchImpl = fetch }) {
  const before = new Set(alreadyNotified);
  const stillHeld = new Set(held.map((item) => item.id));
  const notified = new Set([...before].filter((id) => stillHeld.has(id)));
  const result = { configured: recipients.length > 0, sent: [], failed: [], waiting: [], notified: [] };

  if (!result.configured) {
    result.notified = [...notified];
    return result;
  }

  const pending = held.filter((item) => !before.has(item.id));
  for (const item of pending.slice(0, MAX_MESSAGES_PER_RUN)) {
    const text = formatMessage(repository, item);
    const outcomes = await Promise.all(recipients.map((recipient) => sendWhatsApp(recipient, text, fetchImpl)));
    if (outcomes.some((outcome) => outcome.ok)) {
      notified.add(item.id);
      result.sent.push({ id: item.id, delivered: outcomes.filter((outcome) => outcome.ok).length, of: outcomes.length });
    } else {
      result.failed.push({ id: item.id, reason: outcomes[0].detail });
    }
  }
  result.waiting = pending.slice(MAX_MESSAGES_PER_RUN).map((item) => item.id);
  result.notified = [...notified];
  return result;
}

export function renderNotifyReport(result) {
  const lines = [];
  if (!result.configured) {
    lines.push("WhatsApp alerts are not set up (no `CALLMEBOT_RECIPIENTS` secret), so nobody was messaged about the held prices above.");
  } else {
    if (result.sent.length) lines.push(`WhatsApp: messaged about ${result.sent.map((s) => s.id).join(", ")}.`);
    if (result.failed.length) lines.push(`WhatsApp FAILED for ${result.failed.map((f) => `${f.id} (${f.reason})`).join("; ")}. It will be tried again tomorrow.`);
    if (result.waiting.length) lines.push(`More alerts will go out tomorrow: ${result.waiting.join(", ")}.`);
    if (!lines.length) lines.push("WhatsApp: nobody new to message today.");
  }
  lines.push("", `<!-- notified: ${result.notified.join(",")} -->`);
  return lines.join("\n");
}
