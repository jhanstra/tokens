#!/usr/bin/env -S bun run
/**
 * tokens — report your Cursor token usage
 *
 * Personal CLI that calculates your Cursor token usage (primarily output
 * tokens) for the current month and reports progress toward a configurable
 * monthly goal. Also breaks out today's usage so you can see how you're pacing
 * intraday. Uses the undocumented
 * https://cursor.com/api/dashboard/get-filtered-usage-events endpoint that
 * powers the Cursor dashboard.
 *
 * --------------------------------------------------------------------------
 * One-time setup
 * --------------------------------------------------------------------------
 * 1. Open https://cursor.com/dashboard in a browser where you are logged in.
 * 2. DevTools (Cmd+Opt+I) -> Application -> Cookies -> https://cursor.com
 * 3. Copy the value of the `WorkosCursorSessionToken` cookie.
 * 4. Run one of the following:
 *      tokens --set-token '<paste value here>'
 *      CURSOR_SESSION_TOKEN='<paste value here>' tokens
 *
 * The Cursor session token is cached at ~/.config/cursor-usage/token
 * (chmod 0600). Nothing is written to this repo.
 *
 * Despite the filename, this script contains NO secrets and NO PHI. The only
 * auth material it handles is your personal Cursor dashboard session cookie,
 * which is stored outside the repo.
 *
 * --------------------------------------------------------------------------
 * Usage
 * --------------------------------------------------------------------------
 *   tokens                 # current calendar month, goal 5M output tokens
 *   tokens --month         # current calendar month (explicit)
 *   tokens --days 7        # trailing 7 days
 *   tokens --since 2026-04-01
 *   tokens --goal 5000000  # custom monthly output-token goal
 *   tokens --json          # raw JSON summary
 *   tokens --by-day        # per-day breakdown in addition to models
 *   tokens --verbose       # log each API page as it paginates
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Cursor API and defaults.
const API_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const PAGE_SIZE = 100;
const DEFAULT_MONTHLY_GOAL = 5_000_000;
const TOKEN_PATH = join(homedir(), ".config", "cursor-usage", "token");

// -------- types ----------------------------------------------------------

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  // Cursor sometimes uses this variant field. Included defensively.
  totalCents?: number;
};

type UsageEvent = {
  timestamp: string; // epoch millis as a string
  model?: string;
  kind?: string; // e.g. "USAGE_BASED" | "INCLUDED_IN_PRO" | ...
  tokenUsage?: TokenUsage;
  usageBasedCosts?: unknown;
};

type ApiResponse = {
  usageEventsDisplay?: UsageEvent[];
  totalUsageEventsCount?: number;
  pagination?: { hasMore?: boolean };
};

type ModelTotals = {
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type DayTotals = {
  date: string; // YYYY-MM-DD (local)
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// -------- args -----------------------------------------------------------

type Args = {
  setToken?: string;
  month: boolean;
  days?: number;
  since?: string; // YYYY-MM-DD
  until?: string; // YYYY-MM-DD
  goal: number;
  json: boolean;
  byDay: boolean;
  verbose: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    month: false,
    goal: DEFAULT_MONTHLY_GOAL,
    json: false,
    byDay: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--set-token":
        args.setToken = next();
        break;
      case "--month":
        args.month = true;
        break;
      case "--days":
        args.days = Number(next());
        break;
      case "--since":
        args.since = next();
        break;
      case "--until":
        args.until = next();
        break;
      case "--goal":
        args.goal = Number(next());
        break;
      case "--json":
        args.json = true;
        break;
      case "--by-day":
        args.byDay = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`Unknown flag: ${a}`);
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`tokens — report your Cursor token usage

Usage:
  tokens [options]

Options:
  --set-token <value>  Save a WorkosCursorSessionToken to ~/.config/cursor-usage/token
  --month              Current calendar month (default)
  --days <N>           Trailing N days instead of current month
  --since <YYYY-MM-DD> Custom start date (local time, inclusive)
  --until <YYYY-MM-DD> Custom end date (local time, exclusive). Defaults to now.
  --goal <N>           Monthly output-token goal (default 5,000,000)
  --by-day             Also print a per-day breakdown
  --json               Emit machine-readable JSON instead of the formatted report
  -v, --verbose        Log each API page as it paginates
  -h, --help           Show this help

Token precedence: CURSOR_SESSION_TOKEN env var > cached file at ${TOKEN_PATH}.
`);
}

// -------- token handling -------------------------------------------------

function saveToken(raw: string): void {
  const token = normalizeToken(raw);
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, token, "utf8");
  chmodSync(TOKEN_PATH, 0o600);
  console.log(`Saved token to ${TOKEN_PATH} (chmod 0600).`);
}

function loadToken(): string | null {
  const fromEnv = process.env.CURSOR_SESSION_TOKEN;
  if (fromEnv && fromEnv.trim()) return normalizeToken(fromEnv);
  if (existsSync(TOKEN_PATH)) {
    const contents = readFileSync(TOKEN_PATH, "utf8").trim();
    if (contents) return normalizeToken(contents);
  }
  return null;
}

// The API expects a `Cookie: WorkosCursorSessionToken=<value>` header. Accept
// either just the value or the full cookie string so users can paste whatever
// they grabbed from DevTools.
function normalizeToken(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (trimmed.toLowerCase().startsWith("workoscursorsessiontoken=")) {
    return trimmed;
  }
  return `WorkosCursorSessionToken=${trimmed}`;
}

// -------- date helpers ---------------------------------------------------

function startOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function parseLocalDate(s: string): Date {
  // Treat YYYY-MM-DD as local midnight, not UTC, to align with how humans
  // think about "since April 1st".
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date (expected YYYY-MM-DD): ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function resolveRange(args: Args): { start: Date; end: Date; label: string } {
  const now = new Date();
  if (args.since) {
    const start = parseLocalDate(args.since);
    const end = args.until ? parseLocalDate(args.until) : now;
    return { start, end, label: `${fmtDate(start)} → ${fmtDate(end)}` };
  }
  if (typeof args.days === "number" && !Number.isNaN(args.days)) {
    const start = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);
    return { start, end: now, label: `trailing ${args.days}d` };
  }
  const start = startOfMonth(now);
  return {
    start,
    end: now,
    label: `${start.toLocaleString("en-US", { month: "long", year: "numeric" })} (month-to-date)`,
  };
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDayKey(epochMs: number): string {
  return fmtDate(new Date(epochMs));
}

// -------- API ------------------------------------------------------------

async function fetchPage(
  token: string,
  start: Date,
  end: Date,
  page: number,
): Promise<ApiResponse> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://cursor.com",
      referer: "https://cursor.com/dashboard?tab=usage",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      cookie: token,
    },
    body: JSON.stringify({
      teamId: 0,
      startDate: String(start.getTime()),
      endDate: String(end.getTime()),
      page,
      pageSize: PAGE_SIZE,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Cursor API returned ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }
  return (await res.json()) as ApiResponse;
}

async function fetchAllEvents(
  token: string,
  start: Date,
  end: Date,
  verbose: boolean,
): Promise<UsageEvent[]> {
  const all: UsageEvent[] = [];
  let page = 1;
  // Hard ceiling to guard against an API that misreports pagination.
  const maxPages = 500;
  while (page <= maxPages) {
    const resp = await fetchPage(token, start, end, page);
    const events = resp.usageEventsDisplay ?? [];
    all.push(...events);
    if (verbose) {
      console.error(
        `[page ${page}] fetched ${events.length} events (running total: ${all.length}${
          resp.totalUsageEventsCount ? ` / ${resp.totalUsageEventsCount}` : ""
        })`,
      );
    }
    const hasMore = resp.pagination?.hasMore;
    // If the API doesn't report pagination, fall back to "fewer than a full page means done".
    if (hasMore === false) break;
    if (hasMore === undefined && events.length < PAGE_SIZE) break;
    if (events.length === 0) break;
    page++;
  }
  return all;
}

// -------- aggregation ----------------------------------------------------

type Totals = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function emptyTotals(): Totals {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function addEvent(target: Totals, e: UsageEvent): void {
  const u = e.tokenUsage ?? {};
  target.events += 1;
  target.inputTokens += u.inputTokens ?? 0;
  target.outputTokens += u.outputTokens ?? 0;
  target.cacheReadTokens += u.cacheReadTokens ?? 0;
  target.cacheWriteTokens += u.cacheWriteTokens ?? 0;
}

function startOfToday(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function aggregate(
  events: UsageEvent[],
  start: Date,
  end: Date,
): {
  overall: Totals;
  today: Totals;
  byModel: ModelTotals[];
  byDay: DayTotals[];
} {
  const overall = emptyTotals();
  const today = emptyTotals();
  const byModel = new Map<string, ModelTotals>();
  const byDay = new Map<string, DayTotals>();

  const startMs = start.getTime();
  const endMs = end.getTime();
  const todayStartMs = startOfToday().getTime();

  for (const e of events) {
    const ts = Number(e.timestamp);
    if (!Number.isFinite(ts)) continue;
    // The API is inclusive on both ends by ms, so re-filter locally to be safe.
    if (ts < startMs || ts > endMs) continue;

    addEvent(overall, e);
    if (ts >= todayStartMs) addEvent(today, e);

    const model = (e.model || "unknown").toString();
    let m = byModel.get(model);
    if (!m) {
      m = {
        model,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byModel.set(model, m);
    }
    addEvent(m, e);

    const day = localDayKey(ts);
    let d = byDay.get(day);
    if (!d) {
      d = {
        date: day,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byDay.set(day, d);
    }
    addEvent(d, e);
  }

  return {
    overall,
    today,
    byModel: [...byModel.values()].sort((a, b) => b.outputTokens - a.outputTokens),
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// -------- formatting -----------------------------------------------------

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

function bar(p: number, width = 30): string {
  const clamped = Math.max(0, Math.min(100, p));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function printReport(
  range: { start: Date; end: Date; label: string },
  totals: ReturnType<typeof aggregate>,
  goal: number,
  showByDay: boolean,
): void {
  const { overall, today, byModel, byDay } = totals;
  const outputPct = pct(overall.outputTokens, goal);

  const now = new Date();
  const endOfThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const msRemaining = endOfThisMonth.getTime() - now.getTime();
  const daysRemaining = Math.max(0, msRemaining / (24 * 60 * 60 * 1000));
  const remainingToGoal = Math.max(0, goal - overall.outputTokens);
  const perDayToHit = daysRemaining > 0 ? remainingToGoal / daysRemaining : remainingToGoal;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const perDayFlatGoal = goal / daysInMonth;

  const isMonthlyView =
    range.start.getDate() === 1 &&
    range.start.getMonth() === now.getMonth() &&
    range.start.getFullYear() === now.getFullYear();

  // Is "today" actually inside the selected range? If you asked for last
  // month, showing today's tokens would be misleading.
  const rangeIncludesToday =
    startOfToday().getTime() >= range.start.getTime() &&
    startOfToday().getTime() <= range.end.getTime();

  console.log(`Cursor usage — ${range.label}`);
  console.log(
    `  ${fmtDate(range.start)}  →  ${fmtDate(range.end)}   (${fmtInt(overall.events)} events)\n`,
  );

  console.log(`  Output tokens:       ${fmtInt(overall.outputTokens)}`);
  console.log(`  Input tokens:        ${fmtInt(overall.inputTokens)}`);
  console.log(`  Cache read tokens:   ${fmtInt(overall.cacheReadTokens)}`);
  console.log(`  Cache write tokens:  ${fmtInt(overall.cacheWriteTokens)}`);

  if (rangeIncludesToday) {
    console.log(`\nToday so far (${fmtDate(new Date())}):`);
    console.log(
      `  Output: ${fmtInt(today.outputTokens)}   Input: ${fmtInt(today.inputTokens)}   Events: ${fmtInt(today.events)}`,
    );
    // Compare today's output against the flat per-day share of the monthly
    // goal, so "am I on pace today?" is obvious at a glance.
    const todayVsDailyGoalPct = pct(today.outputTokens, perDayFlatGoal);
    console.log(
      `  vs. daily goal share (${fmtInt(Math.round(perDayFlatGoal))}/day): ${bar(todayVsDailyGoalPct, 20)}  ${todayVsDailyGoalPct.toFixed(1)}%`,
    );
  }

  console.log("");
  console.log(`Goal progress (output tokens, goal ${fmtInt(goal)}):`);
  console.log(`  ${bar(outputPct)}  ${outputPct.toFixed(1)}%`);
  console.log(
    `  ${fmtInt(overall.outputTokens)} / ${fmtInt(goal)}   (${fmtInt(remainingToGoal)} remaining)`,
  );

  if (isMonthlyView) {
    console.log(
      `  Days left in month: ${daysRemaining.toFixed(1)}   Pace needed: ${fmtInt(Math.ceil(perDayToHit))} output tokens/day`,
    );
    // What pace are we actually on?
    const dayOfMonth = now.getDate();
    const elapsedDays = dayOfMonth; // rough, includes today
    const projected =
      elapsedDays > 0 ? (overall.outputTokens / elapsedDays) * daysInMonth : 0;
    const projectedPct = pct(projected, goal);
    console.log(
      `  Current pace projects to ${fmtInt(Math.round(projected))} (${projectedPct.toFixed(1)}% of goal) by month end.`,
    );
  }

  if (byModel.length > 0) {
    console.log("\nTop models by output tokens:");
    const topN = byModel.slice(0, 10);
    const nameWidth = Math.max(...topN.map((m) => m.model.length), 10);
    for (const m of topN) {
      const p = pct(m.outputTokens, overall.outputTokens || 1);
      console.log(
        `  ${m.model.padEnd(nameWidth)}  out=${fmtCompact(m.outputTokens).padStart(7)}   in=${fmtCompact(m.inputTokens).padStart(7)}   cacheR=${fmtCompact(m.cacheReadTokens).padStart(7)}   cacheW=${fmtCompact(m.cacheWriteTokens).padStart(7)}   events=${String(m.events).padStart(4)}   ${p.toFixed(1)}%`,
      );
    }
    if (byModel.length > topN.length) {
      console.log(`  …and ${byModel.length - topN.length} more`);
    }
  }

  if (showByDay && byDay.length > 0) {
    console.log("\nPer-day output tokens:");
    const maxOut = Math.max(...byDay.map((d) => d.outputTokens), 1);
    for (const d of byDay) {
      const p = pct(d.outputTokens, maxOut);
      console.log(
        `  ${d.date}  ${bar(p, 20)}  out=${fmtCompact(d.outputTokens).padStart(7)}   events=${String(d.events).padStart(4)}`,
      );
    }
  }
}

// -------- main -----------------------------------------------------------

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    printHelp();
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (args.setToken) {
    saveToken(args.setToken);
    return;
  }

  const token = loadToken();
  if (!token) {
    console.error(
      `No Cursor session token found.\n\n` +
        `Set one with:\n` +
        `  tokens --set-token '<WorkosCursorSessionToken value>'\n` +
        `or:\n` +
        `  CURSOR_SESSION_TOKEN='<value>' tokens\n\n` +
        `How to grab the value: https://cursor.com/dashboard -> DevTools -> Application -> Cookies -> cursor.com -> WorkosCursorSessionToken\n`,
    );
    process.exit(1);
  }

  const range = resolveRange(args);
  if (args.verbose) {
    console.error(
      `Fetching events from ${range.start.toISOString()} to ${range.end.toISOString()}`,
    );
  }

  let events: UsageEvent[];
  try {
    events = await fetchAllEvents(token, range.start, range.end, args.verbose);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`Failed to fetch usage data: ${msg}`);
    // Cursor redirects unauthenticated requests to a WorkOS login page, which
    // manifests as 401/403 or — because the path becomes /user_management/… —
    // a 404 referencing `user_management` or `authkit`. Any of those almost
    // always mean the session token is stale.
    if (/401|403|user_management|authkit/i.test(msg)) {
      console.error(
        `\nYour session token is probably expired. Grab a fresh one from the Cursor dashboard and rerun with --set-token.`,
      );
    }
    process.exit(1);
  }

  const totals = aggregate(events, range.start, range.end);

  if (args.json) {
    const payload = {
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        label: range.label,
      },
      goal: args.goal,
      totals: totals.overall,
      today: {
        date: fmtDate(new Date()),
        ...totals.today,
      },
      byModel: totals.byModel,
      byDay: totals.byDay,
      progress: {
        outputPct: pct(totals.overall.outputTokens, args.goal),
        outputRemaining: Math.max(0, args.goal - totals.overall.outputTokens),
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printReport(range, totals, args.goal, args.byDay);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
