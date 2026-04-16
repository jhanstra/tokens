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
 * The monthly goal math is work-day aware: it divides by actual US work days
 * in the current month (Mon–Fri minus US federal holidays), not 30. See the
 * work-day helpers section below for details.
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
 *   tokens --no-color      # disable ANSI colors
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
  noColor: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    month: false,
    goal: DEFAULT_MONTHLY_GOAL,
    json: false,
    byDay: false,
    verbose: false,
    help: false,
    noColor: false,
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
      case "--no-color":
        args.noColor = true;
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

// -------- styling --------------------------------------------------------
//
// Tiny ANSI helper. No dependencies so this stays a single-file Bun script.
// Colors are automatically suppressed when stdout isn't a TTY, when NO_COLOR
// is set, or when the user passes --no-color or --json.

type StyleFn = (s: string | number) => string;

type Style = {
  enabled: boolean;
  reset: string;
  bold: StyleFn;
  dim: StyleFn;
  italic: StyleFn;
  underline: StyleFn;
  red: StyleFn;
  green: StyleFn;
  yellow: StyleFn;
  blue: StyleFn;
  magenta: StyleFn;
  cyan: StyleFn;
  gray: StyleFn;
  // Semantic helpers
  title: StyleFn;
  label: StyleFn;
  value: StyleFn;
  accent: StyleFn;
  good: StyleFn;
  warn: StyleFn;
  bad: StyleFn;
  muted: StyleFn;
};

function makeStyle(enabled: boolean): Style {
  const wrap = (code: string): StyleFn => {
    if (!enabled) return (s) => String(s);
    return (s) => `\x1b[${code}m${s}\x1b[0m`;
  };
  return {
    enabled,
    reset: enabled ? "\x1b[0m" : "",
    bold: wrap("1"),
    dim: wrap("2"),
    italic: wrap("3"),
    underline: wrap("4"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
    title: wrap("1;36"), // bold cyan
    label: wrap("90"), // gray
    value: wrap("1"), // bold default color
    accent: wrap("36"), // cyan
    good: wrap("32"), // green
    warn: wrap("33"), // yellow
    bad: wrap("31"), // red
    muted: wrap("2;37"), // dim white
  };
}

function shouldUseColor(args: Args): boolean {
  // Explicit user intent wins.
  if (args.noColor) return false;
  if (args.json) return false;
  // FORCE_COLOR overrides NO_COLOR, matching Node's convention.
  if (process.env.FORCE_COLOR) return true;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

// Visible width of a string, ignoring ANSI escape sequences. Good enough for
// the plain ASCII/Unicode chars this CLI uses.
function visibleLength(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(s: string): number {
  return visibleLength(s).length;
}

function padEndVisible(s: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(s));
  return s + " ".repeat(pad);
}

function padStartVisible(s: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(s));
  return " ".repeat(pad) + s;
}

function printHelp(style: Style): void {
  const t = style.title;
  const b = style.bold;
  const dim = style.dim;
  const accent = style.accent;
  console.log(`${t("tokens")} ${dim("—")} report your Cursor token usage

${b("Usage")}
  ${accent("tokens")} [options]

${b("Options")}
  ${accent("--set-token")} <value>   Save a WorkosCursorSessionToken to ~/.config/cursor-usage/token
  ${accent("--month")}               Current calendar month (default)
  ${accent("--days")} <N>            Trailing N days instead of current month
  ${accent("--since")} <YYYY-MM-DD>  Custom start date (local time, inclusive)
  ${accent("--until")} <YYYY-MM-DD>  Custom end date (local time, exclusive). Defaults to now.
  ${accent("--goal")} <N>            Monthly output-token goal (default 5,000,000)
  ${accent("--by-day")}              Also print a per-day breakdown
  ${accent("--json")}                Emit machine-readable JSON instead of the formatted report
  ${accent("--no-color")}            Disable ANSI colors
  ${accent("-v")}, ${accent("--verbose")}         Log each API page as it paginates
  ${accent("-h")}, ${accent("--help")}            Show this help

${b("Token precedence")}
  ${dim("CURSOR_SESSION_TOKEN")} env var ${dim(">")} cached file at ${dim(TOKEN_PATH)}
`);
}

// -------- token handling -------------------------------------------------

function saveToken(raw: string, style: Style): void {
  const token = normalizeToken(raw);
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, token, "utf8");
  chmodSync(TOKEN_PATH, 0o600);
  console.log(
    `${style.good("✓")} Saved token to ${style.accent(TOKEN_PATH)} ${style.dim("(chmod 0600)")}`,
  );
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

// -------- work-day helpers ----------------------------------------------
//
// A "work day" here is a US Mon–Fri that isn't a US federal holiday. Used
// by the monthly goal math so the "per-day share" and "pace needed"
// numbers don't count weekends or Thanksgiving against you.

// Nth weekday of a month, e.g. 3rd Monday of January. `nth` is 1-indexed,
// `weekday` is 0 (Sun) .. 6 (Sat).
function nthWeekdayOfMonth(year: number, monthIdx: number, weekday: number, nth: number): Date {
  const first = new Date(year, monthIdx, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, monthIdx, 1 + offset + (nth - 1) * 7);
}

// Last weekday of a month (e.g. last Monday of May for Memorial Day).
function lastWeekdayOfMonth(year: number, monthIdx: number, weekday: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0);
  const offset = (lastDay.getDay() - weekday + 7) % 7;
  return new Date(year, monthIdx, lastDay.getDate() - offset);
}

// Observed date for a holiday that falls on a weekend: Saturday → Friday,
// Sunday → Monday. Matches the US federal "in lieu of" rules.
function observedDate(d: Date): Date {
  const day = d.getDay();
  if (day === 6) return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1); // Sat -> Fri
  if (day === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); // Sun -> Mon
  return d;
}

// Compute observed US federal holidays for a given calendar year. Includes
// Juneteenth (added 2021) and skips it for earlier years so historical
// ranges stay correct.
function usFederalHolidays(year: number): Set<string> {
  const out = new Set<string>();
  const add = (d: Date) => out.add(fmtDate(observedDate(d)));
  add(new Date(year, 0, 1)); // New Year's Day
  add(nthWeekdayOfMonth(year, 0, 1, 3)); // MLK Day (3rd Mon of Jan)
  add(nthWeekdayOfMonth(year, 1, 1, 3)); // Presidents' Day (3rd Mon of Feb)
  add(lastWeekdayOfMonth(year, 4, 1)); // Memorial Day (last Mon of May)
  if (year >= 2021) add(new Date(year, 5, 19)); // Juneteenth
  add(new Date(year, 6, 4)); // Independence Day
  add(nthWeekdayOfMonth(year, 8, 1, 1)); // Labor Day (1st Mon of Sep)
  add(nthWeekdayOfMonth(year, 9, 1, 2)); // Columbus Day (2nd Mon of Oct)
  add(new Date(year, 10, 11)); // Veterans Day
  add(nthWeekdayOfMonth(year, 10, 4, 4)); // Thanksgiving (4th Thu of Nov)
  add(new Date(year, 11, 25)); // Christmas Day
  return out;
}

const HOLIDAY_CACHE = new Map<number, Set<string>>();
function holidaysFor(year: number): Set<string> {
  let s = HOLIDAY_CACHE.get(year);
  if (!s) {
    s = usFederalHolidays(year);
    HOLIDAY_CACHE.set(year, s);
  }
  return s;
}

function isWorkDay(d: Date): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  return !holidaysFor(d.getFullYear()).has(fmtDate(d));
}

// Count work days in [start, endExclusive). Caller is responsible for
// passing local-midnight boundaries.
function countWorkDays(start: Date, endExclusive: Date): number {
  let n = 0;
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const end = new Date(endExclusive.getFullYear(), endExclusive.getMonth(), endExclusive.getDate());
  while (d.getTime() < end.getTime()) {
    if (isWorkDay(d)) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

// Work days in the calendar month containing `d`.
function workDaysInMonth(d: Date): number {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return countWorkDays(start, end);
}

// Work days strictly before today (so today is never "done" yet).
function workDaysCompletedInMonth(d: Date): number {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return countWorkDays(start, today);
}

// Work days remaining, counting today if it's a work day. This is the
// denominator you want for "pace needed": how many work days do I still
// have to spend?
function workDaysRemainingInMonth(d: Date): number {
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return countWorkDays(today, end);
}

// Sum of completed + remaining always equals workDaysInMonth, which makes
// the display "N done · M left of T" always add up regardless of whether
// today is a work day.

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
  style: Style,
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
      const total = resp.totalUsageEventsCount
        ? ` ${style.dim(`/ ${resp.totalUsageEventsCount}`)}`
        : "";
      console.error(
        `${style.dim(`[page ${page}]`)} fetched ${style.accent(String(events.length))} events ${style.dim(`(running total: ${all.length}${total})`)}`,
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

// Smooth Unicode progress bar. Uses eighth-block glyphs so partial cells are
// visible, which makes the "am I on pace" read much more accurate than a
// coarse `####----` bar. Colors shift green→yellow→red as the bar fills.
function bar(p: number, width = 32, style?: Style): string {
  const blocks = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]; // 1/8 .. 7/8
  const full = "█";
  const clamped = Math.max(0, Math.min(100, p));
  const totalEighths = (clamped / 100) * width * 8;
  const fullCells = Math.floor(totalEighths / 8);
  const remainder = Math.floor(totalEighths - fullCells * 8);

  let filled = full.repeat(fullCells);
  if (fullCells < width) filled += blocks[remainder] ?? "";
  const emptyCount = Math.max(0, width - fullCells - (remainder > 0 ? 1 : 0));
  const empty = "·".repeat(emptyCount);

  if (!style || !style.enabled) return `${filled}${empty}`;

  const color =
    clamped >= 100 ? style.good : clamped >= 75 ? style.yellow : clamped >= 50 ? style.cyan : style.blue;
  return `${color(filled)}${style.dim(empty)}`;
}

function sparkline(values: number[], style?: Style): string {
  const ticks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const out = values
    .map((v) => {
      const idx = Math.min(ticks.length - 1, Math.max(0, Math.round((v / max) * (ticks.length - 1))));
      return ticks[idx];
    })
    .join("");
  return style && style.enabled ? style.cyan(out) : out;
}

// Section header with a subtle rule underneath.
function section(title: string, style: Style): string {
  const rule = "─".repeat(Math.max(8, visibleWidth(title) + 2));
  return `${style.title(title)}\n${style.dim(rule)}`;
}

function printReport(
  range: { start: Date; end: Date; label: string },
  totals: ReturnType<typeof aggregate>,
  goal: number,
  showByDay: boolean,
  style: Style,
): void {
  const { overall, today, byModel, byDay } = totals;
  const outputPct = pct(overall.outputTokens, goal);

  const now = new Date();
  const remainingToGoal = Math.max(0, goal - overall.outputTokens);

  // Goal math is work-day aware: US Mon–Fri, minus federal holidays. This
  // keeps the "per-day share" honest on weekends and Thanksgiving.
  const totalWorkDays = workDaysInMonth(now);
  const workDaysDone = workDaysCompletedInMonth(now); // strictly before today
  const workDaysLeft = workDaysRemainingInMonth(now); // today (if work day) + rest
  // Rate denominator for projection: work days actually in play so far,
  // counting today as a day you've partially worked if it's a work day.
  const workDaysInPlay = workDaysDone + (isWorkDay(now) ? 1 : 0);
  const perWorkDayFlatGoal = totalWorkDays > 0 ? goal / totalWorkDays : goal;
  const perWorkDayToHit =
    workDaysLeft > 0 ? remainingToGoal / workDaysLeft : remainingToGoal;
  const todayIsWorkDay = isWorkDay(now);

  const isMonthlyView =
    range.start.getDate() === 1 &&
    range.start.getMonth() === now.getMonth() &&
    range.start.getFullYear() === now.getFullYear();

  // Is "today" actually inside the selected range? If you asked for last
  // month, showing today's tokens would be misleading.
  const rangeIncludesToday =
    startOfToday().getTime() >= range.start.getTime() &&
    startOfToday().getTime() <= range.end.getTime();

  // ------------ header ------------
  console.log("");
  console.log(
    `${style.title("◆ Cursor usage")}  ${style.dim("·")}  ${style.accent(range.label)}`,
  );
  console.log(
    `  ${style.label("range")}   ${fmtDate(range.start)} ${style.dim("→")} ${fmtDate(range.end)}   ${style.dim("·")}   ${style.label("events")} ${style.value(fmtInt(overall.events))}`,
  );
  console.log("");

  // ------------ totals ------------
  console.log(section("Totals", style));
  const totalRows: Array<[string, number, StyleFn]> = [
    ["Output tokens", overall.outputTokens, style.good],
    ["Input tokens", overall.inputTokens, style.blue],
    ["Cache read", overall.cacheReadTokens, style.cyan],
    ["Cache write", overall.cacheWriteTokens, style.magenta],
  ];
  const labelW = Math.max(...totalRows.map((r) => r[0].length));
  const valueW = Math.max(...totalRows.map((r) => fmtInt(r[1]).length));
  for (const [label, value, color] of totalRows) {
    console.log(
      `  ${style.label(padEndVisible(label, labelW))}   ${color(padStartVisible(fmtInt(value), valueW))}   ${style.dim(padStartVisible(fmtCompact(value), 7))}`,
    );
  }

  // ------------ today ------------
  if (rangeIncludesToday) {
    console.log("");
    console.log(section(`Today  ${style.dim(`(${fmtDate(new Date())})`)}`, style));
    console.log(
      `  ${style.label("output")} ${style.good(fmtInt(today.outputTokens))}   ${style.label("input")} ${style.blue(fmtInt(today.inputTokens))}   ${style.label("events")} ${style.value(fmtInt(today.events))}`,
    );
    // Compare today's output against the flat per-work-day share of the
    // monthly goal. On weekends/holidays there's no share to hit today —
    // anything you do is bonus, so we report it that way.
    if (todayIsWorkDay) {
      const todayVsDailyGoalPct = pct(today.outputTokens, perWorkDayFlatGoal);
      const paceColor =
        todayVsDailyGoalPct >= 100 ? style.good : todayVsDailyGoalPct >= 60 ? style.yellow : style.red;
      console.log(
        `  ${style.label("pace ")} ${bar(todayVsDailyGoalPct, 22, style)} ${paceColor(`${todayVsDailyGoalPct.toFixed(1)}%`)}   ${style.dim(`of ${fmtInt(Math.round(perWorkDayFlatGoal))}/work-day share`)}`,
      );
    } else {
      console.log(
        `  ${style.label("pace ")} ${style.dim("non-work day")}   ${style.dim(`(work-day share is ${fmtInt(Math.round(perWorkDayFlatGoal))}/day)`)}`,
      );
    }
  }

  // ------------ goal ------------
  console.log("");
  console.log(section(`Monthly goal  ${style.dim(`(${fmtInt(goal)} output)`)}`, style));
  const goalColor =
    outputPct >= 100 ? style.good : outputPct >= 75 ? style.yellow : style.accent;
  console.log(`  ${bar(outputPct, 32, style)} ${goalColor(`${outputPct.toFixed(1)}%`)}`);
  console.log(
    `  ${style.label("progress")} ${style.value(fmtInt(overall.outputTokens))} ${style.dim("/")} ${style.dim(fmtInt(goal))}   ${style.label("remaining")} ${style.value(fmtInt(remainingToGoal))}`,
  );

  if (isMonthlyView) {
    const projected =
      workDaysInPlay > 0 ? (overall.outputTokens / workDaysInPlay) * totalWorkDays : 0;
    const projectedPct = pct(projected, goal);
    const projectionColor =
      projectedPct >= 100 ? style.good : projectedPct >= 75 ? style.yellow : style.red;

    const paceNeeded =
      workDaysLeft > 0
        ? `${fmtInt(Math.ceil(perWorkDayToHit))}${style.dim("/work-day")}`
        : style.dim("none — month is over");

    const todayTag = todayIsWorkDay ? style.dim(" (incl. today)") : style.dim(" (today off)");
    console.log(
      `  ${style.label("work days")} ${style.value(`${workDaysLeft}`)}${style.dim(" left")}${todayTag}${style.dim(` · ${workDaysDone}/${totalWorkDays} done`)}   ${style.label("pace needed")} ${style.value(paceNeeded)}`,
    );
    console.log(
      `  ${style.label("projection")} ${projectionColor(fmtInt(Math.round(projected)))} ${style.dim(`(${projectedPct.toFixed(1)}% of goal at current work-day pace)`)}`,
    );
  }

  // ------------ models ------------
  if (byModel.length > 0) {
    console.log("");
    console.log(section("Top models by output", style));
    const topN = byModel.slice(0, 10);
    const totalOut = overall.outputTokens || 1;
    const nameW = Math.max(...topN.map((m) => m.model.length), 10);
    const numW = 8; // width for compact numbers like "12.3k" / "4.56M"
    const eventsW = Math.max(4, ...topN.map((m) => String(m.events).length));

    // Header row
    console.log(
      `  ${style.dim(padEndVisible("model", nameW))}  ${style.dim(padStartVisible("out", numW))}  ${style.dim(padStartVisible("in", numW))}  ${style.dim(padStartVisible("cacheR", numW))}  ${style.dim(padStartVisible("cacheW", numW))}  ${style.dim(padStartVisible("events", eventsW))}  ${style.dim("share")}`,
    );
    for (const m of topN) {
      const p = pct(m.outputTokens, totalOut);
      console.log(
        `  ${style.value(padEndVisible(m.model, nameW))}  ${style.good(padStartVisible(fmtCompact(m.outputTokens), numW))}  ${style.blue(padStartVisible(fmtCompact(m.inputTokens), numW))}  ${style.cyan(padStartVisible(fmtCompact(m.cacheReadTokens), numW))}  ${style.magenta(padStartVisible(fmtCompact(m.cacheWriteTokens), numW))}  ${style.value(padStartVisible(String(m.events), eventsW))}  ${bar(p, 10, style)} ${style.dim(`${p.toFixed(1)}%`)}`,
      );
    }
    if (byModel.length > topN.length) {
      console.log(`  ${style.dim(`…and ${byModel.length - topN.length} more`)}`);
    }
  }

  // ------------ per-day ------------
  if (showByDay && byDay.length > 0) {
    console.log("");
    console.log(section("Per-day output", style));
    const spark = sparkline(byDay.map((d) => d.outputTokens), style);
    console.log(`  ${style.label("trend")} ${spark}`);
    const maxOut = Math.max(...byDay.map((d) => d.outputTokens), 1);
    const outW = 8;
    const evW = Math.max(4, ...byDay.map((d) => String(d.events).length));
    for (const d of byDay) {
      const p = pct(d.outputTokens, maxOut);
      console.log(
        `  ${style.dim(d.date)}  ${bar(p, 24, style)}  ${style.good(padStartVisible(fmtCompact(d.outputTokens), outW))}  ${style.dim("events")} ${style.value(padStartVisible(String(d.events), evW))}`,
      );
    }
  }

  console.log("");
}

// -------- main -----------------------------------------------------------

async function main(): Promise<void> {
  let args: Args;
  // Parse with a best-effort style (colors only if TTY) so error output is
  // styled but still plain in pipelines.
  const bootstrapStyle = makeStyle(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${bootstrapStyle.bad("error:")} ${(err as Error).message}`);
    printHelp(bootstrapStyle);
    process.exit(2);
  }

  const style = makeStyle(shouldUseColor(args));

  if (args.help) {
    printHelp(style);
    return;
  }

  if (args.setToken) {
    saveToken(args.setToken, style);
    return;
  }

  const token = loadToken();
  if (!token) {
    console.error(
      `${style.bad("✗")} No Cursor session token found.\n\n` +
        `Set one with:\n` +
        `  ${style.accent("tokens --set-token")} '<WorkosCursorSessionToken value>'\n` +
        `or:\n` +
        `  ${style.accent("CURSOR_SESSION_TOKEN=")}'<value>' tokens\n\n` +
        `${style.dim("How to grab the value: https://cursor.com/dashboard → DevTools → Application → Cookies → cursor.com → WorkosCursorSessionToken")}\n`,
    );
    process.exit(1);
  }

  const range = resolveRange(args);
  if (args.verbose) {
    console.error(
      `${style.dim("Fetching events from")} ${style.accent(range.start.toISOString())} ${style.dim("to")} ${style.accent(range.end.toISOString())}`,
    );
  }

  let events: UsageEvent[];
  try {
    events = await fetchAllEvents(token, range.start, range.end, args.verbose, style);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`${style.bad("✗ Failed to fetch usage data:")} ${msg}`);
    // Cursor redirects unauthenticated requests to a WorkOS login page, which
    // manifests as 401/403 or — because the path becomes /user_management/… —
    // a 404 referencing `user_management` or `authkit`. Any of those almost
    // always mean the session token is stale.
    if (/401|403|user_management|authkit/i.test(msg)) {
      console.error(
        `\n${style.warn("Your session token is probably expired.")} Grab a fresh one from the Cursor dashboard and rerun with ${style.accent("--set-token")}.`,
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
      workDays: (() => {
        const n = new Date();
        const total = workDaysInMonth(n);
        const done = workDaysCompletedInMonth(n);
        const left = workDaysRemainingInMonth(n);
        const remaining = Math.max(0, args.goal - totals.overall.outputTokens);
        return {
          totalInMonth: total,
          completedThisMonth: done,
          remainingInMonth: left,
          todayIsWorkDay: isWorkDay(n),
          perWorkDayFlatGoal: total > 0 ? args.goal / total : args.goal,
          perWorkDayToHit: left > 0 ? remaining / left : remaining,
        };
      })(),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printReport(range, totals, args.goal, args.byDay, style);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
