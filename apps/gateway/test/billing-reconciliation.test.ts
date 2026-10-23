import { describe, it, expect } from "vitest";
import { createTestEnv } from "./mocks";
import { reserve, settle, reconcileUsage } from "../src/admission";

const evidence = { providerRequestId: "provider-verified-1", operator: "billing-operator",
  reason: "Matched provider billing export", evidenceSha256: "b".repeat(64) };
async function estimatedRequest() {
  const fixture = createTestEnv();
  fixture.mockD1.provision("user");
  const reservation = (await reserve(fixture.env, "user", {
    model: "deepseek-chat", messages: [{ role: "user", content: "test" }], max_tokens: 100,
  }))!;
  await settle(fixture.env, reservation, { promptTokens: 0, completionTokens: 0, usageMissing: true });
  return { ...fixture, reservation };
}
describe("audited operator reconciliation", () => {
  it("retains original charge and evidence, updates user/global totals once, and refuses altered repeats", async () => {
    const { env, mockD1, reservation } = await estimatedRequest();
    await reconcileUsage(env, reservation.id, 10, 5, evidence);
    await reconcileUsage(env, reservation.id, 10, 5, evidence);
    const ledger = mockD1.sqlite.prepare("SELECT * FROM billing_reconciliations").all() as any[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ old_cost_microusd: reservation.cost, cost_microusd: 20,
      operator: evidence.operator, evidence_sha256: evidence.evidenceSha256 });
    expect(mockD1.sqlite.prepare("SELECT tokens,microusd FROM budget_totals ORDER BY user_id").all())
      .toEqual([{ tokens: 15, microusd: 20 }, { tokens: 15, microusd: 20 }]);
    await expect(reconcileUsage(env, reservation.id, 0, 0, { ...evidence, evidenceSha256: "c".repeat(64) })).rejects.toThrow();
    expect(mockD1.usageRows[0].cost_microusd).toBe(20);
    expect(() => mockD1.sqlite.exec("DELETE FROM billing_reconciliations")).toThrow(/immutable/);
    expect(() => mockD1.sqlite.exec("UPDATE billing_reconciliations SET operator='other'")).toThrow(/immutable/);
  });
  it("rolls back the audit entry when charge correction fails", async () => {
    const { env, mockD1, reservation } = await estimatedRequest();
    mockD1.sqlite.exec("CREATE TRIGGER fail_correction BEFORE UPDATE ON usage BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
    await expect(reconcileUsage(env, reservation.id, 10, 5, evidence)).rejects.toThrow(/disk failure/);
    expect(mockD1.sqlite.prepare("SELECT * FROM billing_reconciliations").all()).toHaveLength(0);
    expect(mockD1.usageRows[0]).toMatchObject({ usage_missing: 1, cost_microusd: reservation.cost });
  });
  it("refuses invalid evidence, unsafe counts and unknown requests without changing billing", async () => {
    const { env, mockD1, reservation } = await estimatedRequest();
    await expect(reconcileUsage(env, reservation.id, 10, 5, { ...evidence, operator: "" })).rejects.toThrow();
    await expect(reconcileUsage(env, reservation.id, Number.MAX_SAFE_INTEGER, 5, evidence)).rejects.toThrow();
    await expect(reconcileUsage(env, "unknown", 10, 5, evidence)).rejects.toThrow();
    expect(mockD1.sqlite.prepare("SELECT * FROM billing_reconciliations").all()).toHaveLength(0);
    expect(mockD1.usageRows[0].usage_missing).toBe(1);
  });
});
