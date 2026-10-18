const SETTLE_MS = Number(process.env.SETTLE_MS ?? 300);

export type ChargeRequest = { amount: number; idempotencyKey: string };

export type Charge = {
  id: string;
  amount: number;
  idempotencyKey: string;
  createdAt: number;
};

export class FakeProvider {
  readonly charges: Charge[] = [];

  async charge({ amount, idempotencyKey }: ChargeRequest): Promise<Charge> {
    const now = Date.now();
    const existing = this.charges.find(
      (c) => c.idempotencyKey === idempotencyKey && now - c.createdAt >= SETTLE_MS,
    );
    if (existing) return existing;
    const charge: Charge = {
      id: `ch_${this.charges.length + 1}`,
      amount,
      idempotencyKey,
      createdAt: now,
    };
    this.charges.push(charge);
    return charge;
  }

  chargeCount(): number {
    return this.charges.length;
  }
}
