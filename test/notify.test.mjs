import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionLinks, formatMessage, notifyHeld, parseRecipients, renderNotifyReport, sendWhatsApp } from "../scripts/lib/notify.mjs";

const REPO = "owner/repo";
const held = (id, from = 29, to = 37.21) => ({ id, name: `Gift ${id}`, from, to });
const okResponse = (body = "Message queued. You should receive it within a few seconds.") => ({ ok: true, status: 200, text: async () => body });
const recorder = (...responses) => {
  const calls = [];
  const fn = async (url) => { calls.push(url); const next = responses.length > 1 ? responses.shift() : responses[0]; return typeof next === "function" ? next(url) : next; };
  fn.calls = calls;
  return fn;
};

describe("recipients", () => {
  it("parses phone:key pairs and ignores junk", () => {
    assert.deepEqual(parseRecipients("+971500000001:abc123, +971500000002:def456"), [{ phone: "+971500000001", key: "abc123" }, { phone: "+971500000002", key: "def456" }]);
    assert.deepEqual(parseRecipients(""), []);
    assert.deepEqual(parseRecipients(undefined), []);
    assert.deepEqual(parseRecipients("nokey,:onlykey,+971500000003:"), []);
  });
});

describe("message", () => {
  it("names the gift, both prices and the change, and carries the Amazon, remove and keep links", () => {
    const text = formatMessage(REPO, held("B0C65Z31KS", 100, 150));
    assert.match(text, /Gift B0C65Z31KS/);
    assert.match(text, /AED 100\.00 on the site, AED 150\.00 on Amazon now \(\+50%\)/);
    assert.ok(text.includes("https://www.amazon.ae/dp/B0C65Z31KS/"));
    const links = decisionLinks(REPO, held("B0C65Z31KS", 100, 150));
    assert.ok(text.includes(links.remove) && text.includes(links.keep));
    assert.equal(new URL(links.remove).searchParams.get("title"), "Remove gift B0C65Z31KS");
    assert.equal(new URL(links.keep).searchParams.get("title"), "Keep gift B0C65Z31KS at AED 150.00");
    assert.ok(links.remove.startsWith("https://github.com/owner/repo/issues/new?"));
  });
});

describe("sendWhatsApp", () => {
  it("calls CallMeBot with the phone, text and key encoded", async () => {
    const fetchImpl = recorder(okResponse());
    const result = await sendWhatsApp({ phone: "+971500000001", key: "k e/y" }, "hello & goodbye", fetchImpl);
    assert.equal(result.ok, true);
    const url = new URL(fetchImpl.calls[0]);
    assert.equal(url.origin + url.pathname, "https://api.callmebot.com/whatsapp.php");
    assert.equal(url.searchParams.get("phone"), "+971500000001");
    assert.equal(url.searchParams.get("text"), "hello & goodbye");
    assert.equal(url.searchParams.get("apikey"), "k e/y");
  });

  it("reports failures without ever revealing the phone number or key", async () => {
    const secret = { phone: "+971500000001", key: "SECRETKEY99" };
    const echoed = recorder({ ok: false, status: 400, text: async () => "<p>ERROR: apikey SECRETKEY99 is invalid for +971500000001</p>" });
    const bad = await sendWhatsApp(secret, "x", echoed);
    assert.equal(bad.ok, false);
    assert.ok(!bad.detail.includes("SECRETKEY99") && !bad.detail.includes("971500000001"), bad.detail);

    const thrown = recorder(() => { throw new Error(`connect failed for ${secret.key}`); });
    const crashed = await sendWhatsApp(secret, "x", thrown);
    assert.equal(crashed.ok, false);
    assert.ok(!crashed.detail.includes("SECRETKEY99"));

    assert.equal((await sendWhatsApp(secret, "x", recorder({ ok: true, status: 200, text: async () => "ERROR: wrong key" }))).ok, false);
  });
});

describe("notifyHeld", () => {
  const recipients = [{ phone: "+971500000001", key: "a" }, { phone: "+971500000002", key: "b" }];

  it("messages each recipient once per held gift and remembers it", async () => {
    const fetchImpl = recorder(okResponse());
    const result = await notifyHeld({ held: [held("B0AAAAAAAA"), held("B0BBBBBBBB")], recipients, repository: REPO, fetchImpl });
    assert.equal(fetchImpl.calls.length, 4);
    assert.deepEqual(result.notified.sort(), ["B0AAAAAAAA", "B0BBBBBBBB"]);
    assert.deepEqual(result.sent.map((s) => [s.id, s.delivered, s.of]), [["B0AAAAAAAA", 2, 2], ["B0BBBBBBBB", 2, 2]]);
  });

  it("does not message again about a gift that is still held, and forgets gifts that stopped being held", async () => {
    const fetchImpl = recorder(okResponse());
    const result = await notifyHeld({ held: [held("B0AAAAAAAA"), held("B0CCCCCCCC")], recipients, alreadyNotified: ["B0AAAAAAAA", "B0GONEGONE"], repository: REPO, fetchImpl });
    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(result.notified.sort(), ["B0AAAAAAAA", "B0CCCCCCCC"]);
    assert.ok(!result.notified.includes("B0GONEGONE"));
  });

  it("counts a gift as notified if at least one person got it, and retries tomorrow if nobody did", async () => {
    const half = recorder((url) => (new URL(url).searchParams.get("apikey") === "a" ? okResponse() : { ok: false, status: 500, text: async () => "ERROR" }));
    assert.deepEqual((await notifyHeld({ held: [held("B0AAAAAAAA")], recipients, repository: REPO, fetchImpl: half })).notified, ["B0AAAAAAAA"]);
    const none = await notifyHeld({ held: [held("B0AAAAAAAA")], recipients, repository: REPO, fetchImpl: recorder({ ok: false, status: 500, text: async () => "ERROR" }) });
    assert.deepEqual(none.notified, []);
    assert.equal(none.failed.length, 1);
  });

  it("caps a run at five messages and queues the rest for tomorrow", async () => {
    const many = Array.from({ length: 7 }, (_, i) => held(`B0000000${i}00`.slice(0, 10)));
    const result = await notifyHeld({ held: many, recipients: [recipients[0]], repository: REPO, fetchImpl: recorder(okResponse()) });
    assert.equal(result.sent.length, 5);
    assert.equal(result.waiting.length, 2);
  });

  it("does nothing, and says so, when no recipients are configured", async () => {
    const fetchImpl = recorder(okResponse());
    const result = await notifyHeld({ held: [held("B0AAAAAAAA")], recipients: [], alreadyNotified: ["B0AAAAAAAA"], repository: REPO, fetchImpl });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(result.configured, false);
    assert.match(renderNotifyReport(result), /not set up/);
    assert.match(renderNotifyReport(result), /<!-- notified: B0AAAAAAAA -->/);
  });

  it("writes a report that never contains a phone number", async () => {
    const result = await notifyHeld({ held: [held("B0AAAAAAAA")], recipients, repository: REPO, fetchImpl: recorder(okResponse()) });
    const report = renderNotifyReport(result);
    assert.match(report, /messaged about B0AAAAAAAA/);
    assert.ok(!/971500/.test(report));
  });
});
