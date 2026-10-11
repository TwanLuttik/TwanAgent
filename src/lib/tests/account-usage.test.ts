import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountUsageIsFresh,
  formatAccountBalance,
  formatAccountReset,
  formatAccountUsed,
  parseAccountUsage,
} from "../account-usage.ts";

describe("parseAccountUsage", () => {
  it("keeps connected Claude windows and drops a bad percent", () => {
    const parsed = parseAccountUsage({
      provider: "anthropic",
      connected: true,
      label: "ada@example.com",
      windows: [
        { id: "five_hour", label: "5h", used_percent: 42.5, resets_at: "2026-07-20T18:00:00Z" },
        { id: "seven_day", label: "7d", used_percent: -1 },
      ],
    });
    assert.equal(parsed?.connected, true);
    assert.equal(parsed?.label, "ada@example.com");
    assert.equal(parsed?.windows.length, 1);
    assert.equal(parsed?.windows[0].usedPercent, 42.5);
    assert.equal(parsed?.windows[0].resetsAt, "2026-07-20T18:00:00Z");
    assert.equal(parsed?.balanceCents, null);
  });

  it("keeps a prepaid balance and a credit status", () => {
    const parsed = parseAccountUsage({
      provider: "anthropic",
      connected: true,
      label: "ada@example.com",
      windows: [],
      balance_cents: 1250,
      balance_currency: "USD",
      credit_status: "available",
    });
    assert.equal(parsed?.balanceCents, 1250);
    assert.equal(parsed?.balanceCurrency, "USD");
    assert.equal(parsed?.creditStatus, "available");
    assert.equal(formatAccountBalance(1250, "USD"), "$12.50");
    assert.equal(formatAccountBalance(null), "");
  });

  it("keeps a MiniMax quota window and a pay-as-you-go balance", () => {
    const parsed = parseAccountUsage({
      provider: "minimax",
      connected: true,
      label: "MiniMax",
      windows: [{ id: "general:week", label: "Week", used_percent: 99, resets_at: "2026-07-26T00:00:00.000Z" }],
    });
    assert.equal(parsed?.provider, "minimax");
    assert.equal(parsed?.windows[0].label, "Week");
    assert.equal(parsed?.windows[0].usedPercent, 99);
    const balance = parseAccountUsage({
      provider: "minimax",
      connected: true,
      label: "MiniMax",
      windows: [],
      balance_cents: 1250,
      balance_currency: "USD",
    });
    assert.equal(balance?.windows.length, 0);
    assert.equal(balance?.balanceCents, 1250);
    assert.equal(formatAccountBalance(1250, "USD"), "$12.50");
  });

  it("reports a disconnected account with no windows", () => {
    const parsed = parseAccountUsage({ provider: "anthropic", connected: false, label: "Claude", windows: [] });
    assert.equal(parsed?.connected, false);
    assert.deepEqual(parsed?.windows, []);
    assert.equal(parseAccountUsage(null), null);
  });

  it("keeps the fetch time and treats a missing one as fresh", () => {
    const now = Date.parse("2026-07-20T12:00:00Z");
    const parsed = parseAccountUsage({
      provider: "anthropic",
      connected: true,
      label: "Claude",
      windows: [],
      fetched_at: "2026-07-20T11:50:00Z",
    });
    assert.equal(parsed?.fetchedAt, "2026-07-20T11:50:00Z");
    assert.equal(accountUsageIsFresh(parsed!, now), true);
    assert.equal(accountUsageIsFresh({ ...parsed!, fetchedAt: "2026-07-20T11:00:00Z" }, now), false);
    assert.equal(accountUsageIsFresh({ ...parsed!, fetchedAt: null }, now), true);
  });
});

describe("formatAccountUsed", () => {
  it("prints a whole percent and clamps the range", () => {
    assert.equal(formatAccountUsed(42.4), "42%");
    assert.equal(formatAccountUsed(4.25), "4.3%");
    assert.equal(formatAccountUsed(140), "100%");
  });
});

describe("formatAccountReset", () => {
  it("counts down to the reset and ignores a bad stamp", () => {
    const now = Date.parse("2026-07-20T12:00:00Z");
    assert.equal(formatAccountReset("2026-07-20T18:00:00Z", now), "6h");
    assert.equal(formatAccountReset("2026-07-20T12:20:00Z", now), "20m");
    assert.equal(formatAccountReset("2026-07-23T12:00:00Z", now), "3d");
    assert.equal(formatAccountReset("not-a-date", now), "");
    assert.equal(formatAccountReset(null, now), "");
    assert.equal(formatAccountReset(String(now + 3 * 3600_000), now), "3h");
  });
});
