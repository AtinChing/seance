import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeCustomer } from "../src/charge.ts";

test("a customer is charged exactly once", async () => {
  const { provider } = await chargeCustomer({ amount: 4200, idempotencyKey: "order-1" });
  assert.equal(provider.chargeCount(), 1);
});
