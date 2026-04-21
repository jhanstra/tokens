#!/usr/bin/env -S bun run
// Pin the process timezone before *anything* constructs a Date. Every
// "today / start-of-month / per-day bucket" calculation in this file uses
// `Date.prototype.getFullYear/getMonth/getDate`, which read in
// process-local time. If the script is launched under `TZ=UTC` (cron,
// launchd, GitHub Actions, a Docker image, or just a misconfigured
// shell), all of those reads quietly shift onto UTC days, which makes
// "today" stop counting evening events the moment UTC rolls over (e.g.
// after 6pm MT during MDT). We force the zone here — overridable via
// TOKENS_TZ, but explicit so a stray TZ in the environment can't
// silently re-break the buckets. Must be the first executable statement.
process.env.TZ = process.env.TOKENS_TZ ?? "America/Denver";

/**
 * tokens — report your Cursor token usage.
 *
 * Calculates your Cursor token usage (primarily output tokens) for the
 * current month and reports progress toward a configurable monthly goal.
 * Also breaks out today's usage so you can see how you're pacing intraday.
 * Uses the undocumented
 * https://cursor.com/api/dashboard/get-filtered-usage-events endpoint that
 * powers the Cursor dashboard.
 *
 * All "today" / "this month" / per-day bucketing happens in TOKENS_TZ
 * (default America/Denver). See the TZ pin at the very top of this file
 * for why — short version: launchers that set TZ=UTC otherwise drop
 * evening events out of "today" once UTC rolls over.
 *
 * The monthly goal math is work-day aware: it divides by actual US work
 * days in the current month (Mon–Fri minus US federal holidays), not 30.
 * See the work-day helpers section below for details.
 *
 * The periodic repo-review subcommand that used to live here as
 * `tokens info` is now its own CLI at ~/headway/bugs. See ../bugs.
 *
 * --------------------------------------------------------------------------
 * One-time setup
 * --------------------------------------------------------------------------
 * Grab a Cursor session cookie:
 * 1. Open https://cursor.com/dashboard in a browser where you are logged in.
 * 2. DevTools (Cmd+Opt+I) -> Application -> Cookies -> https://cursor.com
 * 3. Copy the value of the `WorkosCursorSessionToken` cookie.
 * 4. Run one of the following:
 *      tokens --set-token '<paste value here>'
 *      CURSOR_SESSION_TOKEN='<paste value here>' tokens
 *
 * The Cursor session token is cached at ~/.config/cursor-usage/token
 * (chmod 0600). Nothing is written into this repo.
 *
 * Despite the filename, this script contains NO secrets and NO PHI. The
 * only auth material it handles is your personal Cursor dashboard session
 * cookie, which is stored outside the repo.
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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Cursor API and defaults.
const API_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const PAGE_SIZE = 100;
const DEFAULT_MONTHLY_GOAL = 5_000_000;
const CONFIG_DIR = join(homedir(), ".config", "cursor-usage");
const TOKEN_PATH = join(CONFIG_DIR, "token");
// Small cache used by --prompt (fast, offline) and written by --refresh-cache.
// Shape is intentionally tiny so reads stay under a millisecond: the prompt
// renderer parses this on every prompt redraw and must never block.
const CACHE_PATH = join(CONFIG_DIR, "cache.json");

// -------- cost + environmental impact estimates -------------------------
//
// These numbers are intentionally *estimates*. Cursor's dashboard shows
// actual billed cents via the `usageBasedCosts` field, but the shape of
// that field has changed over time and isn't populated for plan-included
// events, so we compute our own figure from token counts against a
// provider-list-price table. Treat output as "rough order of magnitude"
// rather than "what you were actually charged."
//
// Pricing: USD per 1M tokens, using published provider list prices.
// Sources (checked 2026-04):
//   - Anthropic Claude:  https://docs.anthropic.com/en/about-claude/pricing
//   - OpenAI:            https://openai.com/api/pricing
//   - Google Gemini:     https://ai.google.dev/gemini-api/docs/pricing
//
// Models we haven't explicitly priced fall back to DEFAULT_PRICING, a
// midrange Sonnet-like number chosen so unknown models don't silently
// drop out of the cost column.
type Pricing = {
  inputPerMTokens: number; // USD per 1M input tokens
  outputPerMTokens: number; // USD per 1M output tokens
  cacheReadPerMTokens: number; // USD per 1M cache-read tokens
  cacheWritePerMTokens: number; // USD per 1M cache-write tokens
};

const DEFAULT_PRICING: Pricing = {
  inputPerMTokens: 3.0,
  outputPerMTokens: 15.0,
  cacheReadPerMTokens: 0.3,
  cacheWritePerMTokens: 3.75,
};

// Keys are matched as case-insensitive substrings of the model name. Order
// matters: the first pattern in PRICING_PATTERNS that matches a model wins,
// so put more specific patterns (e.g. "opus-4-1") before more general ones
// ("opus", then "claude"). New Cursor model aliases like
// "claude-4.6-opus-high-thinking" or "claude-opus-4-7-max" still resolve
// to the live Opus row via the "opus" substring match, which is why we
// match on a short family tag rather than the full model string.
//
// Cache rates use Anthropic's standard 5-minute cache schedule
// (cache write = 1.25x base input, cache read = 0.10x base input). The
// 1-hour cache tier (2x write) is rare in interactive Cursor sessions, so
// we don't model it separately — it would only nudge cost by a few % even
// for sessions that opt in.
const PRICING_PATTERNS: Array<{ match: string; pricing: Pricing }> = [
  // Anthropic Claude. Opus > Sonnet > Haiku. Prices are Anthropic list
  // prices; Cursor's own margin isn't reflected here.
  //
  // Older Opus (3, 4, 4.1) was $15/$75 per 1M and is now deprecated. Match
  // those explicit version slugs before the catch-all "opus" row so
  // historical date ranges still cost out correctly.
  { match: "opus-4-1", pricing: { inputPerMTokens: 15.0, outputPerMTokens: 75.0, cacheReadPerMTokens: 1.5, cacheWritePerMTokens: 18.75 } },
  { match: "opus-4.1", pricing: { inputPerMTokens: 15.0, outputPerMTokens: 75.0, cacheReadPerMTokens: 1.5, cacheWritePerMTokens: 18.75 } },
  { match: "opus-4-0", pricing: { inputPerMTokens: 15.0, outputPerMTokens: 75.0, cacheReadPerMTokens: 1.5, cacheWritePerMTokens: 18.75 } },
  { match: "opus-3", pricing: { inputPerMTokens: 15.0, outputPerMTokens: 75.0, cacheReadPerMTokens: 1.5, cacheWritePerMTokens: 18.75 } },
  // Live Opus tier (4.5 / 4.6 / 4.7): $5 in / $25 out per 1M, with the
  // 5-minute cache schedule (write 1.25x = $6.25, read 0.10x = $0.50).
  { match: "opus", pricing: { inputPerMTokens: 5.0, outputPerMTokens: 25.0, cacheReadPerMTokens: 0.5, cacheWritePerMTokens: 6.25 } },
  { match: "sonnet", pricing: { inputPerMTokens: 3.0, outputPerMTokens: 15.0, cacheReadPerMTokens: 0.3, cacheWritePerMTokens: 3.75 } },
  { match: "haiku-3", pricing: { inputPerMTokens: 0.25, outputPerMTokens: 1.25, cacheReadPerMTokens: 0.03, cacheWritePerMTokens: 0.3 } },
  { match: "haiku", pricing: { inputPerMTokens: 1.0, outputPerMTokens: 5.0, cacheReadPerMTokens: 0.1, cacheWritePerMTokens: 1.25 } },
  // Treat bare "claude" as Sonnet-ish — the most common default tier.
  { match: "claude", pricing: { inputPerMTokens: 3.0, outputPerMTokens: 15.0, cacheReadPerMTokens: 0.3, cacheWritePerMTokens: 3.75 } },

  // OpenAI. GPT-5 / Codex variants; nano and mini are priced separately.
  { match: "gpt-5-nano", pricing: { inputPerMTokens: 0.2, outputPerMTokens: 1.25, cacheReadPerMTokens: 0.02, cacheWritePerMTokens: 0.2 } },
  { match: "gpt-5-mini", pricing: { inputPerMTokens: 0.75, outputPerMTokens: 4.5, cacheReadPerMTokens: 0.075, cacheWritePerMTokens: 0.75 } },
  { match: "gpt-5", pricing: { inputPerMTokens: 1.25, outputPerMTokens: 10.0, cacheReadPerMTokens: 0.125, cacheWritePerMTokens: 1.25 } },
  { match: "codex", pricing: { inputPerMTokens: 1.25, outputPerMTokens: 10.0, cacheReadPerMTokens: 0.125, cacheWritePerMTokens: 1.25 } },
  { match: "gpt-4.1", pricing: { inputPerMTokens: 2.0, outputPerMTokens: 8.0, cacheReadPerMTokens: 0.5, cacheWritePerMTokens: 2.0 } },
  { match: "gpt-4", pricing: { inputPerMTokens: 2.5, outputPerMTokens: 10.0, cacheReadPerMTokens: 0.5, cacheWritePerMTokens: 2.5 } },
  { match: "o4", pricing: { inputPerMTokens: 2.5, outputPerMTokens: 10.0, cacheReadPerMTokens: 0.5, cacheWritePerMTokens: 2.5 } },
  { match: "o3", pricing: { inputPerMTokens: 2.0, outputPerMTokens: 8.0, cacheReadPerMTokens: 0.5, cacheWritePerMTokens: 2.0 } },

  // Google Gemini.
  { match: "gemini-2.5-flash", pricing: { inputPerMTokens: 0.3, outputPerMTokens: 2.5, cacheReadPerMTokens: 0.075, cacheWritePerMTokens: 0.3 } },
  { match: "gemini-2.5-pro", pricing: { inputPerMTokens: 1.25, outputPerMTokens: 10.0, cacheReadPerMTokens: 0.3125, cacheWritePerMTokens: 1.25 } },
  { match: "gemini-flash", pricing: { inputPerMTokens: 0.3, outputPerMTokens: 2.5, cacheReadPerMTokens: 0.075, cacheWritePerMTokens: 0.3 } },
  { match: "gemini", pricing: { inputPerMTokens: 1.25, outputPerMTokens: 10.0, cacheReadPerMTokens: 0.3125, cacheWritePerMTokens: 1.25 } },

  // Cursor's in-house Composer models. Cursor doesn't publish list prices
  // for these, so we mark them essentially free (the "cost" a free user
  // sees is zero). We still compute energy/CO2 for them below.
  { match: "composer", pricing: { inputPerMTokens: 0, outputPerMTokens: 0, cacheReadPerMTokens: 0, cacheWritePerMTokens: 0 } },
  { match: "cursor-small", pricing: { inputPerMTokens: 0, outputPerMTokens: 0, cacheReadPerMTokens: 0, cacheWritePerMTokens: 0 } },
];

function pricingForModel(model: string): Pricing {
  const lower = model.toLowerCase();
  for (const { match, pricing } of PRICING_PATTERNS) {
    if (lower.includes(match)) return pricing;
  }
  return DEFAULT_PRICING;
}

// Energy and emissions estimates. These are the shakiest numbers in the
// file: providers don't publish per-token energy figures, so we use
// midrange values from published benchmarks (ml.energy leaderboard,
// Anthropic/Google sustainability disclosures, Epoch AI analyses). The
// key knobs are exposed as constants so they're easy to tune.
//
// - Output tokens are ~6x more energy-intensive than input tokens at
//   inference time because each output token is a full forward pass,
//   whereas input tokens are processed in parallel during prefill.
// - Cache reads are effectively free (KV cache lookup, no prefill).
// - Cache writes cost roughly the same as normal input tokens.
//
// The final gCO2e figure is Wh * PUE * grid_intensity / 1000.
const ENERGY_WH_PER_INPUT_TOKEN = 0.00005; // 0.05 Wh per 1K input tokens
const ENERGY_WH_PER_OUTPUT_TOKEN = 0.0003; // 0.30 Wh per 1K output tokens
const ENERGY_WH_PER_CACHE_READ_TOKEN = 0.000005; // ~0.005 Wh per 1K cache-read tokens
const ENERGY_WH_PER_CACHE_WRITE_TOKEN = 0.00005; // ~same as input prefill
const DATA_CENTER_PUE = 1.2; // hyperscaler-ish, slightly worse than Google/Meta
// US grid average carbon intensity. eGRID 2023 subregion weighted average
// is ~0.386 kg CO2e/kWh. We round to 390 g/kWh. Providers increasingly
// claim 100% matched renewables on an annual basis, but matched ≠ hourly
// carbon-free, so the grid number is still the honest one.
const GRID_GRAMS_CO2_PER_KWH = 390;

// Water usage estimates. Two scopes, summed:
//
//   1. On-site: datacenter evaporative cooling. Published by Google (2023
//      environmental report) and Microsoft, and modeled by Li et al.
//      "Making AI Less Thirsty" (arXiv 2304.03271, updated for GPT-class
//      models in 2024). Consensus midpoint is roughly 1.5 mL of on-site
//      cooling water per 100 output tokens, with input tokens contributing
//      ~60x less because prefill is compute-bound in parallel rather than
//      heat-producing per-token. Units below are liters per token.
//   2. Off-site: the water footprint of the electricity itself. US
//      thermoelectric + cooling water use averages ~1.8 L/kWh across the
//      grid (USGS/EIA; Macknick et al. 2012). Applied to the post-PUE
//      kWh so it tracks actual draw, not just compute energy.
//
// Both numbers vary wildly by site (air-cooled desert DCs: lower on-site,
// higher offsite; cool humid locations: the reverse). The point here is
// the same as for CO2: a defensible order-of-magnitude estimate, not an
// accounting report.
const WATER_L_PER_INPUT_TOKEN = 0.00000025;      // 0.025 mL per 100 input tokens
const WATER_L_PER_OUTPUT_TOKEN = 0.000015;       // 1.5 mL per 100 output tokens
const WATER_L_PER_CACHE_READ_TOKEN = 0.000000025; // ~10x less than input prefill
const WATER_L_PER_CACHE_WRITE_TOKEN = 0.00000025; // ~same as input prefill
// Liters of water consumed per kWh of electricity at the US grid average.
// Covers thermoelectric cooling + upstream withdrawal; excludes hydropower
// evaporation, which is a separate debate.
const WATER_L_PER_KWH_OFFSITE = 1.8;

type ImpactEstimate = {
  costUsd: number;
  energyWh: number;
  co2Grams: number;
  waterL: number;
};

function estimateImpact(u: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}, model: string): ImpactEstimate {
  const p = pricingForModel(model);
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;

  const costUsd =
    (input * p.inputPerMTokens +
      output * p.outputPerMTokens +
      cacheRead * p.cacheReadPerMTokens +
      cacheWrite * p.cacheWritePerMTokens) /
    1_000_000;

  const energyWh =
    input * ENERGY_WH_PER_INPUT_TOKEN +
    output * ENERGY_WH_PER_OUTPUT_TOKEN +
    cacheRead * ENERGY_WH_PER_CACHE_READ_TOKEN +
    cacheWrite * ENERGY_WH_PER_CACHE_WRITE_TOKEN;

  const kWh = (energyWh * DATA_CENTER_PUE) / 1000;
  const co2Grams = kWh * GRID_GRAMS_CO2_PER_KWH;

  // Water = on-site cooling (per-token) + off-site electricity (per-kWh).
  // On-site uses raw-token counts because cooling scales with inference
  // heat, not with PUE; the off-site term already accounts for full
  // post-PUE draw so it wouldn't be right to apply PUE twice.
  const waterOnsiteL =
    input * WATER_L_PER_INPUT_TOKEN +
    output * WATER_L_PER_OUTPUT_TOKEN +
    cacheRead * WATER_L_PER_CACHE_READ_TOKEN +
    cacheWrite * WATER_L_PER_CACHE_WRITE_TOKEN;
  const waterOffsiteL = kWh * WATER_L_PER_KWH_OFFSITE;
  const waterL = waterOnsiteL + waterOffsiteL;

  return {
    costUsd,
    energyWh: energyWh * DATA_CENTER_PUE,
    co2Grams,
    waterL,
  };
}

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
  costUsd: number;
  energyWh: number;
  co2Grams: number;
  waterL: number;
};

type DayTotals = {
  date: string; // YYYY-MM-DD (local)
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  energyWh: number;
  co2Grams: number;
  waterL: number;
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
  // Prompt integration. --prompt prints one short line from the cache and
  // never hits the network. --refresh-cache runs the normal monthly fetch
  // and writes ~/.config/cursor-usage/cache.json for --prompt to consume.
  prompt: boolean;
  refreshCache: boolean;
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
    prompt: false,
    refreshCache: false,
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
      case "--prompt":
        args.prompt = true;
        break;
      case "--refresh-cache":
        args.refreshCache = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`Unknown flag: ${a}`);
        }
        if (a === "info") {
          // `tokens info` used to be a subcommand; it's now its own CLI.
          throw new Error(
            "'tokens info' has moved to a separate CLI called 'bugs' (~/headway/bugs). " +
              "Install it with: ln -sfn ~/headway/bugs/bugs.ts ~/.local/bin/bugs",
          );
        }
        throw new Error(`Unknown argument: ${a}`);
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
  ${accent("tokens")} [options]             ${dim("# usage report for the current month")}

${b("Options")}
  ${accent("--set-token")} <value>   Save a WorkosCursorSessionToken to ~/.config/cursor-usage/token
  ${accent("--month")}               Current calendar month (default)
  ${accent("--days")} <N>            Trailing N days instead of current month
  ${accent("--since")} <YYYY-MM-DD>  Custom start date (local time, inclusive)
  ${accent("--until")} <YYYY-MM-DD>  Custom end date (local time, exclusive). Defaults to now.
  ${accent("--goal")} <N>            Monthly output-token goal (default 5,000,000)
  ${accent("--by-day")}              Also print a per-day breakdown
  ${accent("--json")}                Emit machine-readable JSON instead of the formatted report
  ${accent("--prompt")}              Print a short colored line from the local cache for a shell prompt (no network)
  ${accent("--refresh-cache")}       Fetch month-to-date and write ${dim("~/.config/cursor-usage/cache.json")} for ${accent("--prompt")}
  ${accent("--no-color")}            Disable ANSI colors
  ${accent("-v")}, ${accent("--verbose")}         Log each API page as it paginates
  ${accent("-h")}, ${accent("--help")}            Show this help

${b("Token precedence")}
  ${dim("CURSOR_SESSION_TOKEN")} env var ${dim(">")} cached file at ${dim(TOKEN_PATH)}

${b("See also")}
  ${accent("bugs")} ${dim("— the repo-review subcommand that used to live here as `tokens info`.")}
  ${dim("  Repo: ~/headway/bugs")}
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

// -------- prompt cache ---------------------------------------------------
//
// The shell prompt needs fresh-ish numbers without paying API latency on
// every redraw. We solve that with a tiny JSON cache:
//
//   --refresh-cache  — does the full monthly fetch and writes CACHE_PATH.
//                      Meant to be kicked off in the background on a cadence.
//   --prompt         — reads CACHE_PATH, never hits the network, and prints
//                      a single short line suitable for Starship's
//                      `[custom.tokens]` module.
//
// Shape is intentionally small and stable. Prompt renderers parse this on
// every keystroke in some setups; keep it minimal.

type PromptCache = {
  // ISO timestamp (seconds precision is fine) of when the cache was written.
  updatedAt: string;
  // The day the `today` figures describe, in local YYYY-MM-DD. We check
  // this on read so a cache left over from yesterday doesn't misreport
  // today's tokens as "ridiculously high" at 12:01am.
  today: string;
  todayOutputTokens: number;
  monthOutputTokens: number;
  monthInputTokens: number;
  monthEvents: number;
  goal: number;
  // Work-day pace context, duplicated into the cache so --prompt stays a
  // pure read. If you change the goal on the CLI, --refresh-cache picks it
  // up the next time it runs; --prompt just reports whatever's current.
  perWorkDayFlatGoal: number;
  todayIsWorkDay: boolean;
};

function readPromptCache(): PromptCache | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const raw = readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as PromptCache;
    if (typeof parsed?.monthOutputTokens !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePromptCache(cache: PromptCache): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  // Atomic-ish write: tmp file + rename, so a prompt render that happens
  // mid-refresh never sees a half-written JSON.
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, CACHE_PATH);
}

// Render the one-line prompt segment from the cache. Uses a style forced
// to ANSI (prompt renderers are not TTY but expect the codes) when
// requested by the caller. Returns an empty string on any failure so the
// prompt just silently disappears rather than showing errors.
function renderPromptLine(style: Style): string {
  const cache = readPromptCache();
  if (!cache) return "";
  // Guard against a stale cache written before midnight. The month
  // totals are still valid — just today's counter rolled over.
  const todayStr = fmtDate(new Date());
  const todayOutput = cache.today === todayStr ? cache.todayOutputTokens : 0;

  const pctOfGoal = pct(cache.monthOutputTokens, cache.goal);
  const goalColor =
    pctOfGoal >= 100 ? style.good : pctOfGoal >= 75 ? style.yellow : style.accent;

  // Color today's count against the flat per-work-day share of the goal,
  // same thresholds the full report uses. On non-work days we skip the
  // color (anything is bonus, no target to hit).
  const todayColor = (() => {
    if (!cache.todayIsWorkDay) return style.dim;
    const p = pct(todayOutput, cache.perWorkDayFlatGoal);
    if (p >= 100) return style.good;
    if (p >= 60) return style.yellow;
    return style.red;
  })();

  const todayPart = `${todayColor(fmtCompact(todayOutput))} ${style.dim("today")}`;
  const monthPart = `${style.value(fmtCompact(cache.monthOutputTokens))}${style.dim("/")}${style.dim(fmtCompact(cache.goal))}`;
  const pctPart = goalColor(`${pctOfGoal.toFixed(0)}%`);
  const sep = style.dim("·");
  return `${todayPart} ${sep} ${monthPart} ${style.dim("(")}${pctPart}${style.dim(")")}`;
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
  costUsd: number;
  energyWh: number;
  co2Grams: number;
  waterL: number;
};

function emptyTotals(): Totals {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    energyWh: 0,
    co2Grams: 0,
    waterL: 0,
  };
}

function addEvent(target: Totals | ModelTotals | DayTotals, e: UsageEvent): void {
  const u = e.tokenUsage ?? {};
  target.events += 1;
  target.inputTokens += u.inputTokens ?? 0;
  target.outputTokens += u.outputTokens ?? 0;
  target.cacheReadTokens += u.cacheReadTokens ?? 0;
  target.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  // Attribute cost/energy/CO2/water to the specific model on the event so
  // the per-model view stays accurate. For overall/day totals, different
  // events in the same bucket may use different models; summing per-event
  // impact still gives the correct bucket total.
  const impact = estimateImpact(u, (e.model || "unknown").toString());
  target.costUsd += impact.costUsd;
  target.energyWh += impact.energyWh;
  target.co2Grams += impact.co2Grams;
  target.waterL += impact.waterL;
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
        costUsd: 0,
        energyWh: 0,
        co2Grams: 0,
        waterL: 0,
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
        costUsd: 0,
        energyWh: 0,
        co2Grams: 0,
        waterL: 0,
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

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0.00";
}

function fmtEnergy(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  if (wh >= 10) return `${wh.toFixed(1)} Wh`;
  if (wh > 0) return `${wh.toFixed(2)} Wh`;
  return "0 Wh";
}

function fmtCo2(grams: number): string {
  if (grams >= 1_000_000) return `${(grams / 1_000_000).toFixed(2)} tCO₂e`;
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kgCO₂e`;
  if (grams >= 10) return `${grams.toFixed(0)} gCO₂e`;
  if (grams > 0) return `${grams.toFixed(1)} gCO₂e`;
  return "0 gCO₂e";
}

// Water volumes span ~6 orders of magnitude (a single query can be a
// fraction of a mL, a month of heavy usage can be several m³), so the
// formatter switches units at natural breakpoints.
function fmtWater(liters: number): string {
  if (liters >= 1000) return `${(liters / 1000).toFixed(2)} m³`;
  if (liters >= 10) return `${liters.toFixed(1)} L`;
  if (liters >= 1) return `${liters.toFixed(2)} L`;
  // Sub-liter volumes read more naturally in mL.
  const ml = liters * 1000;
  if (ml >= 10) return `${ml.toFixed(0)} mL`;
  if (ml > 0) return `${ml.toFixed(1)} mL`;
  return "0 mL";
}

// Turn a water volume into a tangible object. Units picked for wide
// familiarity:
//   -    5 mL ≈ 1 teaspoon
//   -  250 mL ≈ 1 coffee cup
//   -  500 mL ≈ 1 standard water bottle
//   -  150 L  ≈ 1 bathtub fill (UK/US average)
// Below ~1 mL we don't bother — the comparison would be ridiculous.
function waterComparison(liters: number): string | null {
  const ml = liters * 1000;
  if (ml < 1) return null;
  if (ml < 250) {
    const tsp = ml / 5;
    return tsp < 10 ? `${tsp.toFixed(1)} teaspoons` : `${tsp.toFixed(0)} teaspoons`;
  }
  if (liters < 20) {
    // "N water bottles" scans better than "N 500 mL bottles" — a water
    // bottle is culturally ~500 mL already, no need to spell it out.
    const bottles = liters / 0.5;
    const n = bottles < 10 ? bottles.toFixed(1) : bottles.toFixed(0);
    return `${n} water bottles`;
  }
  const tubs = liters / 150;
  if (tubs < 1) return `${(tubs * 100).toFixed(0)}% of a bathtub`;
  return `${tubs.toFixed(1)} bathtubs`;
}

// Turn an emissions figure into something the human brain can picture.
// Picked to be conservative and widely cited: EPA's "~400 g CO2 per mile
// driven" average passenger vehicle, and a mature tree absorbing ~21 kg
// CO2 per year. If the number is tiny, we quietly omit the comparison.
function co2Comparison(grams: number): string | null {
  if (grams < 50) return null;
  if (grams < 4000) {
    const miles = grams / 400;
    const display = miles < 1 ? miles.toFixed(2) : miles.toFixed(1);
    return `~${display} mi driven`;
  }
  const treeYears = grams / 21_000;
  if (treeYears < 1) {
    return `${(treeYears * 12).toFixed(1)} tree-months`;
  }
  return `${treeYears.toFixed(1)} tree-years`;
}

// Turn energy into a relatable comparison. A typical LED bulb is ~10 W, so
// hours-of-LED is a decent intuition pump.
function energyComparison(wh: number): string | null {
  if (wh < 1) return null;
  const ledHours = wh / 10;
  if (ledHours < 1) return `${(ledHours * 60).toFixed(0)} LED-bulb-minutes`;
  if (ledHours < 24) return `${ledHours.toFixed(1)} LED-bulb-hours`;
  return `${(ledHours / 24).toFixed(1)} LED-bulb-days`;
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
    `  ${style.label("range")}   ${fmtDate(range.start)} ${style.dim("→")} ${fmtDate(range.end)}`,
  );
  console.log("");

  // ------------ totals ------------
  // Events lives in this block (and again under "Today" with the
  // intraday count) so each section reports its own event volume rather
  // than burying the range-wide count up in the header.
  console.log(section("Totals", style));
  const totalRows: Array<[string, number, StyleFn]> = [
    ["Output tokens", overall.outputTokens, style.good],
    ["Input tokens", overall.inputTokens, style.blue],
    ["Cache read", overall.cacheReadTokens, style.cyan],
    ["Cache write", overall.cacheWriteTokens, style.magenta],
    ["Events", overall.events, style.value],
  ];
  const labelW = Math.max(...totalRows.map((r) => r[0].length));
  const valueW = Math.max(...totalRows.map((r) => fmtInt(r[1]).length));
  for (const [label, value, color] of totalRows) {
    console.log(
      `  ${style.label(padEndVisible(label, labelW))}   ${color(padStartVisible(fmtInt(value), valueW))}   ${style.dim(padStartVisible(fmtCompact(value), 7))}`,
    );
  }

  // ------------ cost & environmental impact ------------
  console.log("");
  console.log(section("Cost & environmental impact  (estimated)", style));
  const costStr = fmtUsd(overall.costUsd);
  const energyStr = fmtEnergy(overall.energyWh);
  const co2Str = fmtCo2(overall.co2Grams);
  const waterStr = fmtWater(overall.waterL);
  // Keep the four labels aligned with the Totals block for visual rhyme.
  const impactLabelW = Math.max(
    "Est. cost".length,
    "Energy".length,
    "CO₂".length,
    "Water".length,
    labelW,
  );
  console.log(
    `  ${style.label(padEndVisible("Est. cost", impactLabelW))}   ${style.yellow(padStartVisible(costStr, 12))}   ${style.dim("provider list prices, not what Cursor billed")}`,
  );
  // Cost breakdown by token bucket. On long Cursor sessions cache_write is
  // routinely the largest line item (1.25x base input price, multiplied by
  // tens of millions of tokens), so surfacing the components is the
  // difference between "$47, no idea why" and "oh, that's mostly cache".
  // We re-derive the per-bucket subtotals from byModel, where each model's
  // pricing is well-defined; summing across models gives the overall split.
  const bucketCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of byModel) {
    const p = pricingForModel(m.model);
    bucketCost.input += (m.inputTokens * p.inputPerMTokens) / 1_000_000;
    bucketCost.output += (m.outputTokens * p.outputPerMTokens) / 1_000_000;
    bucketCost.cacheRead += (m.cacheReadTokens * p.cacheReadPerMTokens) / 1_000_000;
    bucketCost.cacheWrite += (m.cacheWriteTokens * p.cacheWritePerMTokens) / 1_000_000;
  }
  if (overall.costUsd > 0) {
    const parts: Array<[string, number]> = [
      ["output", bucketCost.output],
      ["input", bucketCost.input],
      ["cacheW", bucketCost.cacheWrite],
      ["cacheR", bucketCost.cacheRead],
    ];
    const breakdown = parts
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${style.dim(k)} ${style.yellow(fmtUsd(v))}`)
      .join(`  ${style.dim("·")}  `);
    console.log(`  ${style.label(padEndVisible("", impactLabelW))}   ${style.dim(padStartVisible("", 12))}   ${breakdown}`);
  }
  const energyComp = energyComparison(overall.energyWh);
  console.log(
    `  ${style.label(padEndVisible("Energy", impactLabelW))}   ${style.cyan(padStartVisible(energyStr, 12))}${energyComp ? `   ${style.dim(`≈ ${energyComp}`)}` : ""}`,
  );
  const co2Comp = co2Comparison(overall.co2Grams);
  console.log(
    `  ${style.label(padEndVisible("CO₂", impactLabelW))}   ${style.magenta(padStartVisible(co2Str, 12))}${co2Comp ? `   ${style.dim(`≈ ${co2Comp}`)}` : ""}`,
  );
  const waterComp = waterComparison(overall.waterL);
  console.log(
    `  ${style.label(padEndVisible("Water", impactLabelW))}   ${style.blue(padStartVisible(waterStr, 12))}${waterComp ? `   ${style.dim(`≈ ${waterComp}`)}` : ""}`,
  );

  // ------------ today ------------
  if (rangeIncludesToday) {
    console.log("");
    console.log(section(`Today  ${style.dim(`(${fmtDate(new Date())})`)}`, style));
    console.log(
      `  ${style.label("output")} ${style.good(fmtInt(today.outputTokens))}   ${style.label("input")} ${style.blue(fmtInt(today.inputTokens))}   ${style.label("events")} ${style.value(fmtInt(today.events))}`,
    );
    // Cache tokens dominate total cost on long Cursor sessions (cache_write
    // is ~1.25x base input price, and a heavy session can write tens of
    // millions of cache tokens). Surfacing them here so the cost line is
    // explainable without re-running with --json.
    if (today.cacheReadTokens > 0 || today.cacheWriteTokens > 0) {
      console.log(
        `  ${style.label("cacheR")} ${style.cyan(fmtInt(today.cacheReadTokens))}   ${style.label("cacheW")} ${style.magenta(fmtInt(today.cacheWriteTokens))}`,
      );
    }
    console.log(
      `  ${style.label("cost  ")} ${style.yellow(fmtUsd(today.costUsd))}   ${style.label("energy")} ${style.cyan(fmtEnergy(today.energyWh))}   ${style.label("CO₂")} ${style.magenta(fmtCo2(today.co2Grams))}   ${style.label("water")} ${style.blue(fmtWater(today.waterL))}`,
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
    const costW = 9; // widths for "$1,234.56"
    const co2W = 10; // widths for "123 kgCO₂e"

    // Header row. We drop cacheR/cacheW here in favor of cost+CO2: the
    // per-model cache numbers are rarely the interesting story, and they
    // make the row too wide to read once cost/CO2 are added.
    console.log(
      `  ${style.dim(padEndVisible("model", nameW))}  ${style.dim(padStartVisible("out", numW))}  ${style.dim(padStartVisible("in", numW))}  ${style.dim(padStartVisible("events", eventsW))}  ${style.dim(padStartVisible("cost", costW))}  ${style.dim(padStartVisible("CO₂", co2W))}  ${style.dim("share")}`,
    );
    for (const m of topN) {
      const p = pct(m.outputTokens, totalOut);
      console.log(
        `  ${style.value(padEndVisible(m.model, nameW))}  ${style.good(padStartVisible(fmtCompact(m.outputTokens), numW))}  ${style.blue(padStartVisible(fmtCompact(m.inputTokens), numW))}  ${style.value(padStartVisible(String(m.events), eventsW))}  ${style.yellow(padStartVisible(fmtUsd(m.costUsd), costW))}  ${style.magenta(padStartVisible(fmtCo2(m.co2Grams), co2W))}  ${bar(p, 10, style)} ${style.dim(`${p.toFixed(1)}%`)}`,
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
    const costW = 9;
    const evW = Math.max(4, ...byDay.map((d) => String(d.events).length));
    for (const d of byDay) {
      const p = pct(d.outputTokens, maxOut);
      console.log(
        `  ${style.dim(d.date)}  ${bar(p, 24, style)}  ${style.good(padStartVisible(fmtCompact(d.outputTokens), outW))}  ${style.yellow(padStartVisible(fmtUsd(d.costUsd), costW))}  ${style.dim("events")} ${style.value(padStartVisible(String(d.events), evW))}`,
      );
    }
  }

  // ------------ methodology note ------------
  console.log("");
  console.log(
    style.dim(
      "  Cost uses provider list prices (Anthropic/OpenAI/Google), not what",
    ),
  );
  console.log(
    style.dim(
      "  Cursor billed. Energy, CO₂, and water are rough estimates: ~0.3 Wh",
    ),
  );
  console.log(
    style.dim(
      "  per 1K output tokens, PUE 1.2, US grid at 390 gCO₂e/kWh, ~1.5 mL",
    ),
  );
  console.log(
    style.dim(
      "  per 100 output tokens on-site + 1.8 L/kWh off-site. See tokens.ts.",
    ),
  );

  console.log("");
}

// -------- main -----------------------------------------------------------

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const bootstrapStyle = makeStyle(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

  let args: Args;
  // Parse with a best-effort style (colors only if TTY) so error output is
  // styled but still plain in pipelines.
  try {
    args = parseArgs(rawArgv);
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

  // --prompt is the hot path for shell prompts. It must never hit the
  // network, never error out, and never block for more than a cache read.
  // A missing/empty cache means "print nothing", which makes the prompt
  // segment simply disappear instead of showing a stale or broken value.
  if (args.prompt) {
    // Starship captures stdout, so force color on here unless the user
    // explicitly asked for --no-color. Without this, we'd see plain text
    // in the prompt because stdout isn't a TTY in that context.
    const promptStyle = makeStyle(!args.noColor);
    const line = renderPromptLine(promptStyle);
    if (line) process.stdout.write(`${line}\n`);
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

  // --refresh-cache always writes a *month-to-date* snapshot, regardless of
  // --since/--days. The cache schema talks about "today" and "month", and
  // storing a trailing-N-day or arbitrary-range window under those names
  // would quietly misreport pace in the prompt. Override the range here so
  // the rest of main() can stay oblivious.
  if (args.refreshCache) {
    args.since = undefined;
    args.until = undefined;
    args.days = undefined;
    args.month = true;
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

  if (args.refreshCache) {
    const now = new Date();
    const cache: PromptCache = {
      updatedAt: now.toISOString(),
      today: fmtDate(now),
      todayOutputTokens: totals.today.outputTokens,
      monthOutputTokens: totals.overall.outputTokens,
      monthInputTokens: totals.overall.inputTokens,
      monthEvents: totals.overall.events,
      goal: args.goal,
      perWorkDayFlatGoal: (() => {
        const total = workDaysInMonth(now);
        return total > 0 ? args.goal / total : args.goal;
      })(),
      todayIsWorkDay: isWorkDay(now),
    };
    writePromptCache(cache);
    if (args.verbose) {
      console.error(
        `${style.good("✓")} Wrote prompt cache ${style.dim(`(${totals.overall.events} events · today ${fmtCompact(totals.today.outputTokens)} · month ${fmtCompact(totals.overall.outputTokens)})`)}`,
      );
    }
    return;
  }

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
      // Metadata so JSON consumers know cost/energy/co2/water are
      // estimates rather than billed numbers. Keep in sync with the
      // constants block at the top of this file.
      estimates: {
        note: "cost is provider list price (not Cursor-billed); energy, co2, and water are modeled estimates",
        pricingSource: "Anthropic/OpenAI/Google published list prices",
        energyModel: {
          whPerInputToken: ENERGY_WH_PER_INPUT_TOKEN,
          whPerOutputToken: ENERGY_WH_PER_OUTPUT_TOKEN,
          whPerCacheReadToken: ENERGY_WH_PER_CACHE_READ_TOKEN,
          whPerCacheWriteToken: ENERGY_WH_PER_CACHE_WRITE_TOKEN,
          dataCenterPue: DATA_CENTER_PUE,
          gridGramsCo2PerKwh: GRID_GRAMS_CO2_PER_KWH,
        },
        waterModel: {
          litersPerInputToken: WATER_L_PER_INPUT_TOKEN,
          litersPerOutputToken: WATER_L_PER_OUTPUT_TOKEN,
          litersPerCacheReadToken: WATER_L_PER_CACHE_READ_TOKEN,
          litersPerCacheWriteToken: WATER_L_PER_CACHE_WRITE_TOKEN,
          litersPerKwhOffsite: WATER_L_PER_KWH_OFFSITE,
        },
      },
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
