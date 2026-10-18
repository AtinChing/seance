import { FakeProvider, type Charge } from "./fakeProvider.ts";
import { FlakyNetwork } from "./network.ts";
import { RETRY_BASE_DELAY, withRetry } from "./retry.ts";

export type ChargeCustomerOptions = {
  amount: number;
  idempotencyKey: string;
  provider?: FakeProvider;
  network?: FlakyNetwork;
  baseDelay?: number;
};

export async function chargeCustomer({
  amount,
  idempotencyKey,
  provider = new FakeProvider(),
  network = new FlakyNetwork(provider),
  baseDelay = RETRY_BASE_DELAY,
}: ChargeCustomerOptions): Promise<{ charge: Charge; provider: FakeProvider }> {
  const charge = await withRetry(() => network.send({ amount, idempotencyKey }), { baseDelay });
  return { charge, provider };
}
