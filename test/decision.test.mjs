import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDecision, parseDecisionTitle } from "../scripts/lib/decision.mjs";

const gifts = [
  { id: "B0AAAAAAAA", name: "First", price: "AED 29.00", image: "assets/B0AAAAAAAA.jpg", amazonUrl: "u1" },
  { id: "B0BBBBBBBB", name: "Second", price: "AED 50.00", image: "assets/B0BBBBBBBB.jpg", amazonUrl: "u2" }
];

describe("parseDecisionTitle", () => {
  it("understands the two exact forms", () => {
    assert.deepEqual(parseDecisionTitle("Remove gift B0C65Z31KS"), { action: "remove", id: "B0C65Z31KS", price: null });
    assert.deepEqual(parseDecisionTitle("Keep gift B0C65Z31KS at AED 37.21"), { action: "keep", id: "B0C65Z31KS", price: 37.21 });
    assert.deepEqual(parseDecisionTitle("  Remove gift B0C65Z31KS  "), { action: "remove", id: "B0C65Z31KS", price: null });
  });

  it("rejects everything else", () => {
    for (const title of ["", undefined, "remove gift B0C65Z31KS", "Remove gift B0C65Z31KS now", "Remove gift b0c65z31ks", "Remove gift B0C65Z31K", "Remove gift B0C65Z31KS at AED 10.00",
      "Keep gift B0C65Z31KS", "Keep gift B0C65Z31KS at AED 10", "Keep gift B0C65Z31KS at AED -5.00", "Keep gift B0C65Z31KS at AED 10.00; rm -rf", "Remove gift B0C65Z31KS\nKeep gift B0AAAAAAAA"]) {
      assert.equal(parseDecisionTitle(title), null, JSON.stringify(title));
    }
  });
});

describe("applyDecision", () => {
  const none = new Set();

  it("removes a gift, remembers it so the morning check stays quiet, and names its image for deletion", () => {
    const out = applyDecision(gifts, ["B0OTHER000"], { action: "remove", id: "B0AAAAAAAA", price: null }, { reserved: none });
    assert.equal(out.ok, true);
    assert.deepEqual(out.gifts.map((g) => g.id), ["B0BBBBBBBB"]);
    assert.deepEqual(out.ignore, ["B0OTHER000", "B0AAAAAAAA"]);
    assert.equal(out.deleteImage, "assets/B0AAAAAAAA.jpg");
    assert.equal(applyDecision(gifts, ["B0AAAAAAAA"], { action: "remove", id: "B0AAAAAAAA", price: null }, { reserved: none }).ignore.length, 1);
  });

  it("keeps a gift at the new price and changes nothing else", () => {
    const out = applyDecision(gifts, [], { action: "keep", id: "B0BBBBBBBB", price: 61.5 }, { reserved: none });
    assert.equal(out.ok, true);
    assert.deepEqual(out.gifts[1], { ...gifts[1], price: "AED 61.50" });
    assert.deepEqual(out.gifts[0], gifts[0]);
    assert.equal(out.deleteImage, null);
  });

  it("refuses, and changes nothing, for an unknown gift or one a guest has reserved", () => {
    const unknown = applyDecision(gifts, [], { action: "remove", id: "B0ZZZZZZZZ", price: null }, { reserved: none });
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /not on the list/);
    const taken = applyDecision(gifts, [], { action: "remove", id: "B0AAAAAAAA", price: null }, { reserved: new Set(["B0AAAAAAAA"]) });
    assert.equal(taken.ok, false);
    assert.match(taken.message, /already been reserved/);
    assert.deepEqual(taken.gifts, gifts);
    assert.equal(applyDecision(gifts, [], { action: "keep", id: "B0AAAAAAAA", price: 40 }, { reserved: new Set(["B0AAAAAAAA"]) }).ok, false);
  });

  it("refuses an unusable price", () => {
    assert.equal(applyDecision(gifts, [], { action: "keep", id: "B0AAAAAAAA", price: 0 }, { reserved: none }).ok, false);
  });
});
