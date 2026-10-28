import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signWebhookForTests, toMinorUnits, toRupees, verifyWebhookSignature } from "./cashfree.client.js";
import { refundableMinor } from "./refunds.service.js";

// Pure rules, no database and no network. Run: npm test

const SECRET = "unit_test_secret";
const BODY = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: "ST12345", order_amount: 2499.5 } } });

test("a webhook signed the way Cashfree documents it (base64 HMAC-SHA256 of timestamp + raw body) is accepted", () => {
  const ts = "1785401067911";
  const sig = crypto.createHmac("sha256", SECRET).update(ts + BODY).digest("base64");
  assert.equal(verifyWebhookSignature(BODY, ts, sig, SECRET), true);
  assert.equal(verifyWebhookSignature(BODY, ts, signWebhookForTests(BODY, ts, SECRET), SECRET), true);
});

test("any change to the body, timestamp, signature or secret is rejected", () => {
  const ts = "1785401067911";
  const sig = signWebhookForTests(BODY, ts, SECRET);
  assert.equal(verifyWebhookSignature(BODY.replace("2499.5", "1"), ts, sig, SECRET), false, "tampered body");
  assert.equal(verifyWebhookSignature(BODY, "1785401067912", sig, SECRET), false, "different timestamp");
  assert.equal(verifyWebhookSignature(BODY, ts, sig.slice(0, -2) + "AA", SECRET), false, "damaged signature");
  assert.equal(verifyWebhookSignature(BODY, ts, sig, "other_secret"), false, "wrong secret");
  assert.equal(verifyWebhookSignature(BODY + " ", ts, sig, SECRET), false, "whitespace change");
});

test("missing pieces are rejected, never accepted by default", () => {
  const ts = "1";
  const sig = signWebhookForTests(BODY, ts, SECRET);
  assert.equal(verifyWebhookSignature(BODY, undefined, sig, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, ts, undefined, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, ts, "", SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, ts, sig, ""), false);
  assert.equal(verifyWebhookSignature(BODY, ts, "not base64 !!", SECRET), false);
});

test("amounts survive the rupee/paise round trip without floating-point drift", () => {
  for (const minor of [1, 99, 100, 199, 249950, 1999999, 2000000000]) {
    assert.equal(toMinorUnits(toRupees(minor)), minor, `${minor} paise`);
  }
  assert.equal(toRupees(249950), 2499.5);
  assert.equal(toMinorUnits(2499.5), 249950);
  assert.equal(toMinorUnits("1999.99"), 199999);
  assert.equal(toMinorUnits(0.1 + 0.2), 30); // the classic float trap
  assert.equal(toMinorUnits(19.99 * 100 / 100), 1999);
});

test("the refundable amount counts pending and completed refunds, not failed ones", () => {
  const payment = (refunds: Array<{ amountMinor: number; status: string }>) => ({ amountMinor: 100000, refunds });
  assert.equal(refundableMinor(payment([])), 100000);
  assert.equal(refundableMinor(payment([{ amountMinor: 30000, status: "COMPLETED" }])), 70000);
  assert.equal(refundableMinor(payment([{ amountMinor: 30000, status: "PENDING" }])), 70000);
  assert.equal(refundableMinor(payment([{ amountMinor: 30000, status: "FAILED" }])), 100000);
  assert.equal(refundableMinor(payment([{ amountMinor: 60000, status: "COMPLETED" }, { amountMinor: 40000, status: "PENDING" }])), 0);
  // never negative, even if the data were somehow over-refunded
  assert.equal(refundableMinor(payment([{ amountMinor: 150000, status: "COMPLETED" }])), 0);
});
