import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUsageGrid,
  buildUsageSnapshot,
  buildUsageTrend,
  dayKey,
  estimateUsageCost,
  formatBytes,
  formatUsd,
  linePath,
  modelRate,
  rangeStartMs,
  teaserIndex,
  USAGE_TEASER_WINDOWS,
  usageCostUsd,
  usageLevel,
  usageSeries,
  usageTotalSince,
  type UsageDay,
  type UsageEvent,
} from "../usage.ts";

function ev(partial: Partial<UsageEvent> & Pick<UsageEvent, "recorded_at" | "workspace_path">): UsageEvent {
  return {
    id: 1,
    workspace_name: "app",
    conversation_id: "c1",
    conversation_title: "Chat",
    model: "grok-4.6",
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    ...partial,
  };
}

describe("formatBytes", () => {
  it("uses a short unit and stays readable", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.50 KB");
    assert.equal(formatBytes(12_288), "12 KB");
    assert.equal(formatBytes(200_000), "195 KB");
    assert.equal(formatBytes(2_500_000), "2.38 MB");
  });
});

describe("dayKey", () => {
  it("uses the local calendar day", () => {
    assert.equal(dayKey("2026-09-17T15:30:00.000Z"), dayKey(new Date("2026-09-17T15:30:00.000Z").toISOString()));
    assert.equal(dayKey("not-a-date"), "");
  });
});

describe("rangeStartMs", () => {
  it("starts at local midnight of the first day in the range", () => {
    const now = Date.parse("2026-09-17T18:00:00.000Z");
    const start = new Date(rangeStartMs(7, now));
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
    const spanDays = Math.round((now - start.getTime()) / 86_400_000);
    assert.ok(spanDays >= 6 && spanDays <= 7);
  });
});

describe("buildUsageSnapshot", () => {
  const now = Date.parse("2026-09-17T18:00:00.000Z");

  it("sums tokens, fills empty days, and groups projects", () => {
    const today = new Date(now);
    const yesterday = new Date(now - 86_400_000);
    const events = [
      ev({
        recorded_at: yesterday.toISOString(),
        workspace_path: "/proj/alpha",
        workspace_name: "alpha",
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
      }),
      ev({
        recorded_at: today.toISOString(),
        workspace_path: "/proj/alpha",
        workspace_name: "alpha",
        prompt_tokens: 400,
        completion_tokens: 50,
        total_tokens: 450,
      }),
      ev({
        recorded_at: today.toISOString(),
        workspace_path: "/proj/beta",
        workspace_name: "beta",
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
      }),
    ];
    const snap = buildUsageSnapshot(events, { range: 7, nowMs: now });
    assert.deepEqual(snap.totals, { prompt: 1500, completion: 260, total: 1760 });
    assert.equal(snap.days.length, 7);
    const last = snap.days[snap.days.length - 1];
    const prev = snap.days[snap.days.length - 2];
    assert.equal(last.prompt, 500);
    assert.equal(last.completion, 60);
    assert.equal(prev.prompt, 1000);
    assert.equal(snap.days[0].prompt, 0);
    assert.deepEqual(
      snap.projects.map((p) => p.name),
      ["alpha", "beta"],
    );
    assert.equal(snap.projects[0].total, 1650);
    assert.equal(snap.projects[1].total, 110);
  });

  it("filters to one project and ignores events outside the range", () => {
    const events = [
      ev({
        recorded_at: new Date(now - 20 * 86_400_000).toISOString(),
        workspace_path: "/proj/alpha",
        workspace_name: "alpha",
        prompt_tokens: 9999,
        completion_tokens: 1,
        total_tokens: 10000,
      }),
      ev({
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/proj/alpha",
        workspace_name: "alpha",
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      }),
      ev({
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/proj/beta",
        workspace_name: "beta",
        prompt_tokens: 80,
        completion_tokens: 8,
        total_tokens: 88,
      }),
    ];
    const snap = buildUsageSnapshot(events, { range: 7, nowMs: now, workspacePath: "/proj/beta/" });
    assert.deepEqual(snap.totals, { prompt: 80, completion: 8, total: 88 });
    assert.equal(snap.projects.length, 1);
    assert.equal(snap.projects[0].name, "beta");
  });
});

describe("estimated cost", () => {
  const now = Date.parse("2026-09-17T18:00:00.000Z");

  it("prices grok-4.6 at the short rate under 200k and the long rate at or above it", () => {
    const events = [
      ev({
        id: 1,
        conversation_id: "short",
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/a",
        model: "grok-4.6",
        prompt_tokens: 100_000,
        completion_tokens: 50_000,
        total_tokens: 150_000,
      }),
      ev({
        id: 2,
        conversation_id: "long",
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/a",
        model: "grok-4.6",
        prompt_tokens: 1_000_000,
        completion_tokens: 500_000,
        total_tokens: 1_500_000,
      }),
    ];
    const cost = estimateUsageCost(events, { range: 7, nowMs: now });
    assert.equal(cost.usd, (100_000 * 2 + 50_000 * 6) / 1_000_000 + (1_000_000 * 4 + 500_000 * 12) / 1_000_000);
    assert.equal(cost.unpricedTokens, 0);
    assert.equal(formatUsd(5), "$5.00");
  });

  it("uses the long-context rate once the request prompt reaches 200k", () => {
    const short = usageCostUsd({ prompt: 1000, completion: 100, total: 1100 }, "grok-4.5", 199_999);
    const long = usageCostUsd({ prompt: 1000, completion: 100, total: 1100 }, "grok-4.5", 200_000);
    assert.equal(short, (1000 * 2 + 100 * 6) / 1_000_000);
    assert.equal(long, (1000 * 4 + 100 * 12) / 1_000_000);
    assert.equal(modelRate("grok-4.7-latest")?.input, 2);
    assert.equal(modelRate("grok-build-0.1-20260309")?.output, 2);
    assert.equal(modelRate("grok-4.20-0309-reasoning-latest")?.input, 1.25);
    assert.equal(modelRate("grok-4"), null);
    assert.equal(modelRate("not-a-model"), null);
  });

  it("prices only the new tokens in a tool loop and skips unknown models", () => {
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(now - 60_000).toISOString(),
        workspace_path: "/a",
        model: "grok-4.7",
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
      }),
      ev({
        id: 2,
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/a",
        model: "grok-4.7",
        prompt_tokens: 1500,
        completion_tokens: 50,
        total_tokens: 1550,
      }),
      ev({
        id: 3,
        conversation_id: "other",
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/a",
        model: "mystery",
        prompt_tokens: 10_000,
        completion_tokens: 0,
        total_tokens: 10_000,
      }),
    ];
    const cost = estimateUsageCost(events, { range: 7, nowMs: now });
    const prompt = 1000 + (1500 - 1000 - 100);
    const completion = 100 + 50;
    assert.equal(cost.usd, (prompt * 2 + completion * 6) / 1_000_000);
    assert.equal(cost.unpricedTokens, 10_000);
    assert.equal(formatUsd(0.0042), "$0.0042");
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(120.4), "$120");
  });

  it("follows the selected project and ignores events outside the range", () => {
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(now - 20 * 86_400_000).toISOString(),
        workspace_path: "/proj/alpha",
        model: "grok-4.6",
        prompt_tokens: 100_000,
        completion_tokens: 0,
        total_tokens: 100_000,
      }),
      ev({
        id: 2,
        conversation_id: "beta",
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/proj/beta",
        model: "grok-4.6",
        prompt_tokens: 100_000,
        completion_tokens: 0,
        total_tokens: 100_000,
      }),
    ];
    const alpha = estimateUsageCost(events, { range: 7, nowMs: now, workspacePath: "/proj/alpha/" });
    const beta = estimateUsageCost(events, { range: 7, nowMs: now, workspacePath: "/proj/beta" });
    assert.equal(alpha.usd, 0);
    assert.equal(beta.usd, 0.2);
  });
});

describe("tool-loop usage", () => {
  const now = Date.parse("2026-09-17T18:02:00.000Z");

  it("counts a growing tool loop once instead of summing every resent prompt", () => {
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(now - 120_000).toISOString(),
        workspace_path: "/proj/coat",
        prompt_tokens: 1500,
        completion_tokens: 190,
        total_tokens: 1690,
      }),
      ev({
        id: 2,
        recorded_at: new Date(now - 60_000).toISOString(),
        workspace_path: "/proj/coat",
        prompt_tokens: 2200,
        completion_tokens: 30,
        total_tokens: 2230,
      }),
      ev({
        id: 3,
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/proj/coat",
        prompt_tokens: 2400,
        completion_tokens: 20,
        total_tokens: 2420,
      }),
    ];
    assert.equal(usageTotalSince(events, now - 6 * 3600_000, now), 2420);
    const snap = buildUsageSnapshot(events, { range: 7, nowMs: now });
    assert.equal(snap.totals.total, 2420);
    assert.equal(snap.totals.prompt, 1500 + (2200 - 1500 - 190) + (2400 - 2200 - 30));
    assert.equal(snap.totals.completion, 190 + 30 + 20);
  });

  it("does not count a duplicated request twice", () => {
    const recorded_at = new Date(now).toISOString();
    const events = [
      ev({ id: 1, recorded_at, workspace_path: "/a", prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
      ev({ id: 2, recorded_at, workspace_path: "/a", prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    ];
    assert.equal(usageTotalSince(events, now - 60_000, now), 120);
  });

  it("does not recount a prompt that stays the same while completion changes", () => {
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(now - 120_000).toISOString(),
        workspace_path: "/a",
        prompt_tokens: 206_406,
        completion_tokens: 223,
        total_tokens: 206_629,
      }),
      ev({
        id: 2,
        recorded_at: new Date(now - 60_000).toISOString(),
        workspace_path: "/a",
        prompt_tokens: 206_406,
        completion_tokens: 176,
        total_tokens: 206_582,
      }),
      ev({
        id: 3,
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/a",
        prompt_tokens: 206_406,
        completion_tokens: 232,
        total_tokens: 206_638,
      }),
    ];
    const snap = buildUsageSnapshot(events, { range: 7, nowMs: now });
    assert.equal(snap.totals.prompt, 206_406);
    assert.equal(snap.totals.completion, 223 + 176 + 232);
    assert.equal(snap.totals.total, 206_406 + 223 + 176 + 232);
    const cost = estimateUsageCost(events, { range: 7, nowMs: now });
    const longInput = 4;
    const longOutput = 12;
    assert.equal(cost.usd, (206_406 * longInput + (223 + 176 + 232) * longOutput) / 1_000_000);
  });
});

describe("usage teaser windows", () => {
  const now = Date.parse("2026-09-17T18:00:00.000Z");

  it("sums tokens inside each rolling window", () => {
    const events = [
      ev({ id: 1, recorded_at: new Date(now - 10 * 60_000).toISOString(), workspace_path: "/a", prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }),
      ev({ id: 2, conversation_id: "c2", recorded_at: new Date(now - 90 * 60_000).toISOString(), workspace_path: "/a", prompt_tokens: 160, completion_tokens: 40, total_tokens: 200 }),
      ev({ id: 3, conversation_id: "c3", recorded_at: new Date(now - 5 * 3600_000).toISOString(), workspace_path: "/a", prompt_tokens: 320, completion_tokens: 80, total_tokens: 400 }),
      ev({ id: 4, conversation_id: "c4", recorded_at: new Date(now - 10 * 3600_000).toISOString(), workspace_path: "/a", prompt_tokens: 640, completion_tokens: 160, total_tokens: 800 }),
    ];
    assert.equal(usageTotalSince(events, now - 30 * 60_000, now), 100);
    assert.equal(usageTotalSince(events, now - 2 * 3600_000, now), 300);
    assert.equal(usageTotalSince(events, now - 6 * 3600_000, now), 700);
    assert.equal(usageTotalSince(events, now - 12 * 3600_000, now), 1500);
  });

  it("walks 30m, 2h, 6h, 12h every 5 seconds", () => {
    assert.equal(USAGE_TEASER_WINDOWS.map((w) => w.label).join(","), "30m,2h,6h,12h");
    assert.equal(teaserIndex(0, 0), 0);
    assert.equal(teaserIndex(4999, 0), 0);
    assert.equal(teaserIndex(5000, 0), 1);
    assert.equal(teaserIndex(15_000, 0), 3);
    assert.equal(teaserIndex(20_000, 0), 0);
  });
});

describe("usageSeries", () => {
  const now = Date.parse("2026-09-17T18:00:00.000Z");
  const since = now - 30 * 60_000;

  it("buckets tokens across the window and ignores outsiders", () => {
    const events = [
      ev({ id: 1, recorded_at: new Date(since - 1).toISOString(), workspace_path: "/a", prompt_tokens: 900, completion_tokens: 99, total_tokens: 999 }),
      ev({ id: 2, conversation_id: "c2", recorded_at: new Date(since).toISOString(), workspace_path: "/a", prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }),
      ev({ id: 3, conversation_id: "c3", recorded_at: new Date(since + 2 * 60_000).toISOString(), workspace_path: "/a", prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }),
      ev({ id: 4, conversation_id: "c4", recorded_at: new Date(since + 2 * 60_000 + 1).toISOString(), workspace_path: "/a", prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
      ev({ id: 5, conversation_id: "c5", recorded_at: new Date(now).toISOString(), workspace_path: "/a", prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }),
      ev({ id: 6, conversation_id: "c6", recorded_at: new Date(now + 1).toISOString(), workspace_path: "/a", prompt_tokens: 800, completion_tokens: 88, total_tokens: 888 }),
    ];
    const series = usageSeries(events, since, now, 15);
    assert.equal(series.length, 15);
    assert.equal(series[0], 10);
    assert.equal(series[1], 25);
    assert.equal(series[14], 40);
    assert.equal(
      series.reduce((sum, n) => sum + n, 0),
      75,
    );
  });

  it("returns zero buckets when empty or inverted", () => {
    assert.deepEqual(usageSeries([], since, now, 4), [0, 0, 0, 0]);
    assert.deepEqual(usageSeries([], now, since, 3), [0, 0, 0]);
  });
});

describe("buildUsageTrend", () => {
  const now = Date.parse("2026-09-17T18:30:00.000Z");

  it("puts the last 24 hours into hourly buckets", () => {
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(now - 24 * 3600_000 + 60_000).toISOString(),
        workspace_path: "/a",
        total_tokens: 100,
        prompt_tokens: 80,
        completion_tokens: 20,
      }),
      ev({
        id: 2,
        conversation_id: "c2",
        recorded_at: new Date(now - 30 * 60_000).toISOString(),
        workspace_path: "/a",
        total_tokens: 40,
        prompt_tokens: 30,
        completion_tokens: 10,
      }),
      ev({
        id: 3,
        recorded_at: new Date(now - 25 * 3600_000).toISOString(),
        workspace_path: "/a",
        total_tokens: 999,
      }),
    ];
    const trend = buildUsageTrend(events, { range: "24h", nowMs: now });
    assert.equal(trend.points.length, 24);
    assert.equal(trend.totals.total, 140);
    assert.equal(trend.points[0].total, 100);
    assert.equal(trend.points[23].total, 40);
    assert.ok(trend.points[0].label.length > 0);
  });

  it("uses one point per day for 30 days and can filter a project", () => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 29);
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(start.getTime() + 3600_000).toISOString(),
        workspace_path: "/proj/alpha",
        total_tokens: 50,
        prompt_tokens: 40,
        completion_tokens: 10,
      }),
      ev({
        id: 2,
        conversation_id: "c2",
        recorded_at: new Date(now).toISOString(),
        workspace_path: "/proj/beta",
        total_tokens: 70,
        prompt_tokens: 60,
        completion_tokens: 10,
      }),
    ];
    const all = buildUsageTrend(events, { range: "30d", nowMs: now });
    assert.equal(all.points.length, 30);
    assert.equal(all.points[0].total, 50);
    assert.equal(all.points[29].total, 70);
    assert.equal(all.totals.total, 120);
    const alpha = buildUsageTrend(events, { range: "30d", nowMs: now, workspacePath: "/proj/alpha/" });
    assert.equal(alpha.totals.total, 50);
    assert.equal(alpha.points[29].total, 0);
  });

  it("counts a tool loop once inside a 7 day hourly series", () => {
    const events = [
      ev({
        id: 1,
        recorded_at: new Date(now - 2 * 3600_000).toISOString(),
        workspace_path: "/a",
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
      }),
      ev({
        id: 2,
        recorded_at: new Date(now - 3600_000).toISOString(),
        workspace_path: "/a",
        prompt_tokens: 1500,
        completion_tokens: 50,
        total_tokens: 1550,
      }),
    ];
    const trend = buildUsageTrend(events, { range: "7d", nowMs: now });
    assert.equal(trend.points.length, 7 * 24);
    assert.equal(trend.totals.total, 1550);
    assert.equal(
      trend.points.reduce((sum, point) => sum + point.total, 0),
      1550,
    );
  });
});

describe("linePath", () => {
  it("builds a polyline across the plot", () => {
    assert.equal(linePath([], 100, 40, 4), "");
    assert.equal(linePath([0], 100, 40, 4), "");
    const d = linePath([0, 10, 5], 100, 40, 0);
    assert.match(d, /^M /);
    assert.match(d, / L /);
  });

  it("draws an empty series through the vertical middle", () => {
    assert.equal(linePath([0, 0, 0], 100, 40, 0), "M 0.0 20.0 L 50.0 20.0 L 100.0 20.0");
  });
});

function day(date: string, total = 0): UsageDay {
  return { date, prompt: total, completion: 0, total };
}

describe("usageLevel", () => {
  it("maps zero or empty max to the empty bucket", () => {
    assert.equal(usageLevel(0, 100), 0);
    assert.equal(usageLevel(10, 0), 0);
    assert.equal(usageLevel(-1, 100), 0);
  });

  it("splits positive totals into four GitHub-style buckets", () => {
    assert.equal(usageLevel(1, 100), 1);
    assert.equal(usageLevel(25, 100), 1);
    assert.equal(usageLevel(26, 100), 2);
    assert.equal(usageLevel(50, 100), 2);
    assert.equal(usageLevel(51, 100), 3);
    assert.equal(usageLevel(75, 100), 3);
    assert.equal(usageLevel(76, 100), 4);
    assert.equal(usageLevel(100, 100), 4);
  });
});

describe("buildUsageGrid", () => {
  it("returns no weeks for an empty range", () => {
    assert.deepEqual(buildUsageGrid([]), []);
  });

  it("pads to Sunday–Saturday weeks and keeps out-of-range cells empty", () => {
    const weeks = buildUsageGrid([
      day("2026-09-11", 10),
      day("2026-09-12", 0),
      day("2026-09-13", 0),
      day("2026-09-14", 0),
      day("2026-09-15", 0),
      day("2026-09-16", 0),
      day("2026-09-17", 100),
    ]);
    assert.equal(weeks.length, 2);
    assert.equal(weeks[0].cells.length, 7);
    assert.equal(weeks[0].cells[0].date, "2026-09-06");
    assert.equal(weeks[0].cells[0].inRange, false);
    assert.equal(weeks[0].cells[5].date, "2026-09-11");
    assert.equal(weeks[0].cells[5].inRange, true);
    assert.equal(weeks[0].cells[5].total, 10);
    assert.equal(weeks[0].cells[5].level, 1);
    assert.equal(weeks[1].cells[4].date, "2026-09-17");
    assert.equal(weeks[1].cells[4].total, 100);
    assert.equal(weeks[1].cells[4].level, 4);
    assert.equal(weeks[1].cells[6].date, "2026-09-19");
    assert.equal(weeks[1].cells[6].inRange, false);
  });

  it("labels the first week and the week that contains the 1st", () => {
    const days: UsageDay[] = [];
    for (let d = 28; d <= 31; d++) days.push(day(`2026-08-${d}`, 1));
    for (let d = 1; d <= 10; d++) days.push(day(`2026-09-${String(d).padStart(2, "0")}`, 1));
    const weeks = buildUsageGrid(days);
    assert.equal(weeks[0].monthLabel, "Aug");
    const labeled = weeks.filter((week) => week.monthLabel);
    assert.ok(labeled.some((week) => week.monthLabel === "Sep"));
  });
});
