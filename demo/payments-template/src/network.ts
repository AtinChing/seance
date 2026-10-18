import type { Charge, ChargeRequest, FakeProvider } from "./fakeProvider.ts";

export class FlakyNetwork {
  private requests = 0;

  constructor(
    private readonly provider: FakeProvider,
    private readonly dropMs = 20,
  ) {}

  async send(request: ChargeRequest): Promise<Charge> {
    const n = this.requests++;
    const charge = await this.provider.charge(request);
    if (n === 0) {
      await new Promise((resolve) => setTimeout(resolve, this.dropMs));
      throw new Error("network timeout");
    }
    return charge;
  }
}
