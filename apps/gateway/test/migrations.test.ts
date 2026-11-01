import { URL } from "node:url";
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
const sql = (file: string) =>
  readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
describe("production migrations", () => {
  it("upgrades existing usage without losing tokens and applies settlement triggers", () => {
    const db = new Database(":memory:");
    db.exec(sql("0001_baseline.sql"));
    db.prepare(
      "INSERT INTO usage(user_id,model,prompt_tokens,completion_tokens,created_at) VALUES ('existing','deepseek-chat',100,50,'2026-10-15T00:00:00.000Z')",
    ).run();
    db.exec(sql("0002_production_admission.sql"));
    db.exec(sql("0003_atomic_budget_totals.sql"));
    db.exec(sql("0004_security_lifecycle.sql"));
    db.exec(sql("0005_billing_reconciliation_audit.sql"));
    db.exec(sql("0006_relay_device_grants.sql"));
    expect(
      (db.prepare("SELECT tokens FROM budget_totals WHERE user_id='existing'").get() as any).tokens,
    ).toBe(150);
    expect(
      (db.prepare("SELECT tokens FROM budget_totals WHERE user_id='*'").get() as any).tokens,
    ).toBe(150);
    db.close();
  });
});
