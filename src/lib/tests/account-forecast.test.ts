import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountFromUsage,
  allowanceKind,
  allowedPerDay,
  forecastAccount,
  forecastHeadline,
  formatForecastWhen,
  formatLocked,
  formatPaceRatio,
  lockedHours,
  pacePerDay,
  primaryWindow,
  runOutAt,
  usedPercentOf,
  historyPoints,
  timelineSlices,
  usageHistoryLine,
  windowDurationMs,
  windowTimeline,
  type ForecastWindow,
} from "../account-forecast.ts";
import type { AccountUsage } from "../account-usage.ts";
import type { UsageEvent } from "../usage.ts";

const NOW = Date.parse("2026-10-16T18:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function window(partial: Partial<ForecastWindow> & Pick<ForecastWindow, "id">): ForecastWindow {
  return {
    label: "5h",
    usedPercent: 50,
    windowMs: 5 * HOUR,
    resetsAt: NOW + 2 * HOUR,
    remaining: false,
    ...partial,
  };
}

function claude(used: number, resetsAt: string, label = "5h"): AccountUsage {
  return {
    provider: "anthropic",
    connected: true,
    label: "ada@example.com",
    windows: [{ id: "five_hour", label, usedPercent: used, resetsAt }],
    balanceCents: null,
    balanceCurrency: null,
    creditStatus: null,
    fetchedAt: new Date(NOW).toISOString(),
  };
}

function ev(atMs: number, model: string, tokens: number): UsageEvent {
  return {
    id: Math.round(atMs),
    recorded_at: new Date(atMs).toISOString(),
    workspace_path: "/proj",
    workspace_name: "proj",
    conversation_id: "c1",
    conversation_title: "Chat",
    model,
    prompt_tokens: tokens,
    completion_tokens: 0,
    total_tokens: tokens,
  };
}

describe("used percent", () => {
  it("keeps Claude's used percent and flips MiniMax remaining", () => {
    assert.equal(usedPercentOf(85, false), 85);
    assert.equal(usedPercentOf(15, true), 85);
    assert.equal(usedPercentOf(140, false), 100);
    assert.equal(usedPercentOf(-4, true), 100);
  });
});

describe("window length", () => {
  it("reads a label before guessing from the reset", () => {
    assert.equal(windowDurationMs("5h", NOW + HOUR, NOW), 5 * HOUR);
    assert.equal(windowDurationMs("Week", NOW + DAY, NOW), 7 * DAY);
    assert.equal(windowDurationMs("7d", null, NOW), 7 * DAY);
    assert.equal(windowDurationMs("session", NOW + 3 * HOUR, NOW), 3 * HOUR);
    assert.equal(windowDurationMs("session", null, NOW), null);
  });

  it("prefers the session window over the weekly one", () => {
    const picked = primaryWindow(
      [window({ id: "week", label: "Week", windowMs: 7 * DAY, resetsAt: NOW + 3 * DAY }), window({ id: "five" })],
      NOW,
    );
    assert.equal(picked?.id, "five");
  });
});

describe("pace and run out", () => {
  it("spreads the used percent across the time since the window opened", () => {
    const row = window({ usedPercent: 80, windowMs: 5 * HOUR, resetsAt: NOW + HOUR });
    const pace = pacePerDay(row, NOW);
    assert.equal(pace.perDay, (80 / (4 * HOUR)) * DAY);
    const runs = runOutAt(80, pace.perMs, NOW);
    assert.ok(runs);
    assert.equal(runs.hours, 1);
    assert.equal(lockedHours(runs, row.resetsAt), 0);
  });

  it("locks the hours between running out and the reset", () => {
    const runs = runOutAt(85, (15 / (8 * HOUR)), NOW);
    assert.ok(runs);
    assert.equal(Math.round(runs.hours), 8);
    assert.equal(Math.round(lockedHours(runs, NOW + 16 * HOUR)), 8);
    assert.equal(formatLocked(8), "8 h");
    assert.equal(formatLocked(0.4), "24 m");
  });

  it("does not invent a run-out when nothing has been used", () => {
    assert.equal(runOutAt(0, 0, NOW), null);
    assert.equal(runOutAt(100, 0, NOW)?.hours, 0);
    assert.equal(allowedPerDay(85, NOW + DAY, NOW), 15);
  });
});

describe("forecast", () => {
  it("projects a Claude window from its own used percent", () => {
    const account = accountFromUsage("anthropic", claude(80, new Date(NOW + 2 * HOUR).toISOString()), NOW);
    assert.equal(account.detail, "ada@example.com");
    assert.equal(account.windows[0].usedPercent, 80);
    assert.equal(account.windows[0].windowMs, 5 * HOUR);
    const row = forecastAccount(account, [], NOW);
    assert.equal(row.usedPercent, 80);
    assert.equal(Math.round(row.runsOut?.hours ?? -1), 1);
    assert.equal(row.lockedHours > 0, true);
    assert.equal(formatPaceRatio(row.pacePerDay, row.allowedPerDay).over, true);
  });

  it("treats a MiniMax remaining percent as used", () => {
    const usage: AccountUsage = {
      provider: "minimax",
      connected: true,
      label: "MiniMax",
      windows: [{ id: "general:current", label: "5h", usedPercent: 99, resetsAt: new Date(NOW + 4 * HOUR).toISOString() }],
      balanceCents: null,
      balanceCurrency: null,
      creditStatus: null,
      fetchedAt: null,
    };
    const account = accountFromUsage("minimax", usage, NOW);
    assert.equal(account.windows[0].usedPercent, 1);
    assert.equal(account.detail, "");
    const row = forecastAccount(account, [ev(NOW - HOUR, "MiniMax-M3", 500)], NOW);
    assert.equal(row.days.some((day) => day.used > 0), true);
  });

  it("counts only accounts that run out before the reset", () => {
    const soon = forecastAccount(
      accountFromUsage("anthropic", claude(90, new Date(NOW + 10 * HOUR).toISOString()), NOW),
      [],
      NOW,
    );
    const fine = forecastAccount(
      accountFromUsage(
        "minimax",
        {
          provider: "minimax",
          connected: true,
          label: "MiniMax",
          windows: [{ id: "week", label: "Week", usedPercent: 99, resetsAt: new Date(NOW + 6 * DAY).toISOString() }],
          balanceCents: null,
          balanceCurrency: null,
          creditStatus: null,
          fetchedAt: null,
        },
        NOW,
      ),
      [],
      NOW,
    );
    const headline = forecastHeadline([soon, fine], NOW);
    assert.equal(headline.count, 1);
    assert.equal(headline.first?.account.id, "anthropic");
    assert.match(formatForecastWhen(soon.runsOut!.atMs, NOW), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) /);
  });

  it("marks a balance with no window as credits", () => {
    const credits = accountFromUsage(
      "openai",
      {
        provider: "openai",
        connected: true,
        label: "GPT",
        windows: [],
        balanceCents: 1250,
        balanceCurrency: "USD",
        creditStatus: null,
        fetchedAt: null,
      },
      NOW,
    );
    assert.equal(allowanceKind(credits), "credits");
    assert.equal(credits.balanceCents, 1250);
    const plan = accountFromUsage(
      "minimax",
      {
        provider: "minimax",
        connected: true,
        label: "MiniMax",
        windows: [{ id: "5h", label: "5h", usedPercent: 80, resetsAt: new Date(NOW + HOUR).toISOString() }],
        balanceCents: null,
        balanceCurrency: null,
        creditStatus: null,
        fetchedAt: null,
      },
      NOW,
    );
    assert.equal(allowanceKind(plan), "plan");
  });

  it("places used and now on the window clock", () => {
    const window: ForecastWindow = {
      id: "5h",
      label: "5h",
      usedPercent: 20,
      windowMs: 5 * HOUR,
      resetsAt: NOW + 4 * HOUR,
      remaining: true,
    };
    const line = windowTimeline(window, 20, NOW);
    assert.ok(line);
    assert.equal(line.openedAt, NOW - HOUR);
    assert.equal(line.now, 0.2);
    assert.equal(line.used, 0.2);
    assert.equal(windowTimeline({ ...window, windowMs: null }, 20, NOW), null);
  });

  it("splits a multi-day window into days and a short one into hours", () => {
    const days = timelineSlices(NOW, NOW + 5 * DAY);
    assert.ok(days.length >= 5 && days.length <= 6);
    assert.equal(days[0]?.label.length, 3);
    const width = days.reduce((sum, slice) => sum + slice.span, 0);
    assert.ok(Math.abs(width - 1) < 0.001);
    const hours = timelineSlices(NOW, NOW + 5 * HOUR);
    assert.ok(hours.length >= 5 && hours.length <= 6);
    assert.match(hours[0]?.label ?? "", /^\d{2}:\d{2}$/);
  });

  it("draws a usage line from stored readings and the live percent", () => {
    const points = historyPoints([
      {
        provider: "minimax",
        windowId: "5h",
        resetsAt: new Date(NOW + 4 * HOUR).toISOString(),
        usedPercent: 80,
        recordedAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
      },
      {
        provider: "other",
        windowId: "5h",
        resetsAt: new Date(NOW + 4 * HOUR).toISOString(),
        usedPercent: 10,
        recordedAt: new Date(NOW - HOUR).toISOString(),
      },
    ]);
    assert.equal(points.length, 1);
    assert.equal(points[0]?.usedPercent, 20);
    const line = usageHistoryLine(points, NOW - HOUR, NOW + 4 * HOUR, NOW, 30);
    assert.equal(line.length, 2);
    assert.equal(line[0]?.y, 0.2);
    assert.equal(line[1]?.y, 0.3);
    assert.ok((line[1]?.x ?? 0) > (line[0]?.x ?? 1));
  });

  it("leaves a disconnected account without a forecast", () => {
    const account = accountFromUsage("anthropic", null, NOW);
    assert.equal(account.reconnect, true);
    const row = forecastAccount(account, [ev(NOW - HOUR, "claude-sonnet-4-6", 1000)], NOW);
    assert.equal(row.window, null);
    assert.equal(row.runsOut, null);
    assert.equal(forecastHeadline([row], NOW).count, 0);
  });
});
