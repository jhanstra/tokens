# tokens

A small personal CLI that reports your [Cursor](https://cursor.com) token
usage for the current month and tells you how you're pacing against a goal.
Single file, single dependency (Bun), no state stored in this repo.

It hits the same undocumented endpoint the Cursor dashboard uses
(`/api/dashboard/get-filtered-usage-events`) and aggregates the events into a
terminal-friendly report: totals, today-so-far, monthly goal progress with a
projection, top models by output tokens, an estimated cost/environmental
impact section, and an optional per-day breakdown.

> The `tokens info` subcommand that used to live here has moved to its own
> CLI: [`bugs`](../bugs). On first run, `bugs` migrates the relevant
> settings from `~/.config/cursor-usage/config.json` to
> `~/.config/bugs/config.json` automatically.

## Preview

```text
◆ Cursor usage  ·  April 2026 (month-to-date)
  range   2026-04-01 → 2026-04-16   ·   events 412

Totals
────────
  Output tokens      2,841,205    2.84M
  Input tokens       9,117,884    9.12M
  Cache read       184,221,004  184.22M
  Cache write       13,005,911   13.01M

Cost & environmental impact  (estimated)
──────────────────────────────────────────
  Est. cost            $204.13   provider list prices, not what Cursor billed
                                 output $71.03  ·  input $45.59  ·  cacheW $81.29  ·  cacheR $6.22
  Energy              3.95 kWh   ≈ 16.5 LED-bulb-days
  CO₂              1.54 kgCO₂e   ≈ 3.9 mi driven
  Water               8.62 L     ≈ 17 water bottles

Today  (2026-04-16)
─────────────────────
  output 172,515   input 561,952   events 23
  cacheR 11,204,886   cacheW 812,031
  cost   $13.87    energy 214.3 Wh   CO₂ 83 gCO₂e   water 467 mL
  pace  ██████████████████████ 75.9%    of 227,273/work-day share

Monthly goal  (5,000,000 output)
──────────────────────────────────
  ██████████████████▏·············· 56.8%
  progress 2,841,205 / 5,000,000   remaining 2,158,795
  work days 11 left (incl. today) · 11/22 done   pace needed 196,254/work-day
  projection 5,328,009 (106.6% of goal at current work-day pace)

Top models by output
──────────────────────
  model                              out       in  events      cost         CO₂  share
  claude-4.6-opus-high-thinking   1.13M    3.57M     287   $127.50   812 gCO₂e  ████▌····· 39.8%
  composer-2-fast                854.2k   5.89M      84     $0.00   278 gCO₂e  ███▏······ 30.1%
  claude-opus-4-7-max            812.4k   828.3k     38    $74.70   417 gCO₂e  ██▉······· 28.6%
  …

  Cost uses provider list prices (Anthropic/OpenAI/Google), not what
  Cursor billed. Energy, CO₂, and water are rough estimates: ~0.3 Wh
  per 1K output tokens, PUE 1.2, US grid at 390 gCO₂e/kWh, ~1.5 mL
  per 100 output tokens on-site + 1.8 L/kWh off-site. See tokens.ts.
```

Colors are auto-detected from the TTY and respect `NO_COLOR`. Pass
`--no-color` or set `NO_COLOR=1` to force plain output; set `FORCE_COLOR=1`
to force colors on.

## Requirements

- [Bun](https://bun.sh) 1.x. (The script uses only the Bun/Node stdlib and
  `fetch`, so there are no package dependencies.)

## One-time setup

1. Open <https://cursor.com/dashboard> in a browser where you are signed in.
2. Open DevTools (⌘⌥I) → **Application** → **Cookies** → `https://cursor.com`.
3. Copy the value of the `WorkosCursorSessionToken` cookie.
4. Save it either as a cached file or an env var:

   ```sh
   ./tokens.ts --set-token '<paste value>'
   # or
   export CURSOR_SESSION_TOKEN='<paste value>'
   ```

The cached token is written to `~/.config/cursor-usage/token` with mode
`0600`. Nothing is written inside this repo.

Tokens expire periodically. When they do, the CLI prints a hint telling you
to grab a fresh cookie and rerun `--set-token`.

### Install as `tokens` on your `$PATH`

The file is self-executing via its shebang. Symlink it somewhere on your
path so you can run `tokens` from anywhere. From inside the repo:

```sh
chmod +x ./tokens.ts
mkdir -p ~/.local/bin
ln -sfn "$PWD/tokens.ts" ~/.local/bin/tokens
hash -r   # refresh zsh/bash command cache in the current shell
```

Make sure `~/.local/bin` is on your `$PATH`. If you ever move the repo,
re-run the `ln -sfn …` command to repoint the symlink — a dangling symlink
shows up as `zsh: command not found: tokens`.

## Usage

```sh
tokens                       # current calendar month (default), 5M output-token goal
tokens --month               # current calendar month (explicit)
tokens --days 7              # trailing 7 days
tokens --since 2026-04-01    # custom start (local time, inclusive)
tokens --since 2026-04-01 --until 2026-04-15
tokens --goal 7500000        # custom monthly output-token goal
tokens --by-day              # add a per-day breakdown with a sparkline
tokens --json                # machine-readable JSON (no colors)
tokens --no-color            # disable ANSI colors
tokens -v                    # log each API page as it paginates
tokens --help
```

### Flags

| Flag | Description |
| ---- | ----------- |
| `--set-token <value>` | Save a `WorkosCursorSessionToken` to `~/.config/cursor-usage/token` (chmod 0600). |
| `--month` | Current calendar month (default). |
| `--days <N>` | Trailing N days instead of the current month. |
| `--since <YYYY-MM-DD>` | Custom start date (local time, inclusive). |
| `--until <YYYY-MM-DD>` | Custom end date (local time, exclusive). Defaults to now. |
| `--goal <N>` | Monthly output-token goal (default `5,000,000`). |
| `--by-day` | Also print a per-day breakdown. |
| `--json` | Emit machine-readable JSON instead of the formatted report. |
| `--prompt` | Print a short colored line from the local cache for a shell prompt (no network). |
| `--refresh-cache` | Fetch month-to-date and write `~/.config/cursor-usage/cache.json` for `--prompt` to consume. |
| `--no-color` | Disable ANSI colors. |
| `-v`, `--verbose` | Log each API page as it paginates. |
| `-h`, `--help` | Show help. |

Token precedence: `CURSOR_SESSION_TOKEN` env var beats the cached file.

### Timezone

All "today / this month / per-day" bucketing happens in `America/Denver`
by default. Override with `TOKENS_TZ`:

```sh
TOKENS_TZ=America/New_York tokens
```

The script pins this zone explicitly (overriding any `TZ` set in the
shell, cron, launchd, or container env) because otherwise launchers that
default to UTC silently drop evening events out of "today" the moment UTC
rolls over — e.g. anything you did after 6pm MT during MDT would
disappear from today's count and only show up in the monthly total.

## Live prompt integration

`tokens --prompt` is a fast, offline renderer that reads
`~/.config/cursor-usage/cache.json` and prints one short colored line like:

```text
822.6k today · 2.09M/5.00M (42%)
```

- `today` is colored green/yellow/red against the flat per-work-day share of
  your monthly goal (≥100% green, ≥60% yellow, else red), dim on non-work days.
- `month/goal (pct)` is colored against the overall monthly target (≥100%
  green, ≥75% yellow, else cyan).
- If the cache is missing/empty, `--prompt` prints nothing and exits 0, so a
  broken or uninitialized state never corrupts your prompt.

The cache is written by `tokens --refresh-cache`, which paginates the Cursor
API (same network cost as a normal `tokens` run). Because prompts redraw on
every Enter and the API takes ~1–3s, **never call `--refresh-cache`
synchronously from a prompt** — run it in the background on a cadence.

### Starship

Add a `[custom.tokens]` module to `~/.config/starship/config.d/tokens.toml`
(or wherever your Starship config lives):

```toml
[custom.tokens]
description = "Cursor token usage for today and month-to-date"
command = "tokens --prompt"
when = true
shell = ["sh", "-c"]
format = "[$output]($style) "
style = ""
```

Then reference `${custom.tokens}` in your Starship `format`.

### Background refresh (zsh)

Drop the refresh trigger into a `precmd` hook so fresh prompts see fresh
numbers without any blocking. This uses file mtime as a debounce so 10 open
terminals don't each poll the API — only the first one within the interval
does:

```sh
# Refresh the tokens cache in the background, at most once per REFRESH_S.
_tokens_refresh_bg() {
  local cache="$HOME/.config/cursor-usage/cache.json"
  local refresh_s=30
  local now=$(date +%s)
  local mtime=0
  [[ -f "$cache" ]] && mtime=$(stat -f %m "$cache" 2>/dev/null || stat -c %Y "$cache" 2>/dev/null || echo 0)
  if (( now - mtime >= refresh_s )); then
    ( tokens --refresh-cache >/dev/null 2>&1 & ) >/dev/null 2>&1
  fi
}
autoload -U add-zsh-hook
add-zsh-hook precmd _tokens_refresh_bg
```

Set `REFRESH_S` higher to be gentler on the undocumented Cursor API. The
endpoint has no published rate limits; 30s is a reasonable default for
"near-live but not chatty."

### tmux (optional)

If you live in tmux, pin the usage line to the status bar instead of the
prompt. In `~/.tmux.conf`:

```tmux
set -g status-interval 5
set -g status-right "#(tokens --prompt --no-color) | %H:%M "
```

tmux handles the refresh cadence on the status bar itself. Pair this with a
cron or launchd job that runs `tokens --refresh-cache` every N seconds so the
cache stays warm even when no terminal is open.

## How the numbers are computed

- **Output tokens** are the primary metric the goal tracks. Input and cache
  tokens are shown for context.
- **Today** is always local-timezone midnight onward.
- The monthly goal math is **work-day aware**. A work day is US Monday–Friday
  minus US federal holidays (including Juneteenth; holidays observed on the
  adjacent Friday/Monday when they fall on a weekend). So for April 2026
  the report divides by 22 work days, not 30 calendar days.
  - **Today's pace** compares today's output against `goal / work-days-in-month`.
    On weekends and holidays there is no daily share to hit, so the pace
    line just says "non-work day" and any output is bonus.
  - **Pace needed** is `remaining / work-days-remaining-in-month`, counting
    today if today is a work day.
  - **Projection** is `output-so-far / work-days-in-play * work-days-in-month`,
    where "in play" means work days fully elapsed plus today when today is a
    work day. Early in the month this will look noisy.
- The script re-filters events locally against your requested range in case
  the API returns a slightly wider window.

### Cost & environmental impact (estimates)

The "Cost & environmental impact" section is deliberately rough. It's
useful as an order-of-magnitude intuition pump, not an accounting report.

- **Cost** is computed from each event's token counts against a baked-in
  table of **provider list prices** (Anthropic, OpenAI, Google) keyed off
  the model name. This is *not* what Cursor billed you — Cursor has its
  own pricing, promotional credits, and plan-included events. For in-house
  Cursor models (`composer-*`, `cursor-small`) cost is set to `$0` because
  there is no public rate card. Models the script doesn't recognize fall
  back to a Sonnet-ish default (`$3 / $15` per 1M input/output) so the
  column doesn't silently collapse to zero.
  - The cost line is broken down by token bucket (`output`, `input`,
    `cacheW`, `cacheR`). On long Cursor sessions cache writes
    (priced at `1.25x` base input on Anthropic's 5-minute cache schedule,
    e.g. `$6.25 / 1M` on Opus 4.7) are routinely the largest line item,
    so they're called out explicitly rather than buried in the total.
  - Current Anthropic family rates (per 1M tokens): **Opus 4.5/4.6/4.7**
    `$5 in / $25 out` (cache write `$6.25`, cache read `$0.50`),
    **Sonnet 4.x** `$3 / $15`, **Haiku 4.5** `$1 / $5`. Older Opus
    (`opus-3`, `opus-4`, `opus-4.1`) keeps the deprecated `$15 / $75`
    schedule for historical reports.
- **Energy** assumes roughly `0.3 Wh` per 1K output tokens, `0.05 Wh` per
  1K input tokens, essentially zero for cache reads, and about the same as
  input for cache writes. These are midrange values from the `ml.energy`
  leaderboard and Anthropic/Google sustainability disclosures — smaller
  models use less, reasoning-heavy traces use more. The final number is
  multiplied by a `PUE` of `1.2` to account for datacenter overhead.
- **CO₂** multiplies energy by `390 gCO₂e/kWh`, a rounded US grid average
  (eGRID 2023 weighted subregion). Hyperscalers often claim 100% matched
  renewables on an annual basis, but matched ≠ hourly carbon-free, so the
  plain grid number is the honest default here.
- **Water** sums two terms. *On-site* datacenter cooling is modeled at
  `~1.5 mL per 100 output tokens`, with input tokens contributing ~60×
  less because prefill is compute-bound and parallel rather than
  per-token heat-producing; cache reads are effectively free, cache
  writes track input. Constants are derived from Google's 2023
  environmental report, Microsoft's disclosures, and Li et al.'s
  "Making AI Less Thirsty" (arXiv 2304.03271). *Off-site* adds
  `1.8 L/kWh` for thermoelectric cooling of the electricity itself
  (USGS/EIA grid average; Macknick et al. 2012), applied to the
  post-PUE kWh. Both numbers vary a lot by region — air-cooled
  datacenters in dry climates shift the balance toward off-site, humid
  sites with evaporative towers the other way. The tool is reporting
  an order-of-magnitude midpoint, not a site-specific truth.
- The comparison snippets (`~3.9 mi driven`, `16.5 LED-bulb-days`,
  `17 water bottles`, `N bathtubs`) use widely-cited conversion
  factors: EPA's ~400 gCO₂ per mile driven, a ~21 kg CO₂/year mature
  tree, 10 W per LED bulb, 5 mL per teaspoon, 500 mL per water bottle,
  and 150 L per bathtub fill.

All constants live at the top of `tokens.ts` under the "cost + environmental
impact estimates" section. Tune them to taste.

## Privacy

- Despite the filename, this script contains no secrets and no PHI.
- The only auth material involved is your personal Cursor dashboard session
  cookie. It is stored outside this repo at `~/.config/cursor-usage/token`
  (or passed via `CURSOR_SESSION_TOKEN` and never persisted).
- All requests go directly from your machine to `cursor.com`.

## Limitations

- The Cursor usage-events endpoint is undocumented and can change without
  notice. If the report starts showing zero events or 401/403s, it usually
  means the cookie expired or the endpoint shape moved.
- The goal logic is output-token-centric and monthly; it's intentionally
  opinionated rather than general-purpose.
- Cost and environmental impact are **modeled estimates**, not measurements.
  They will drift as providers change prices and as inference hardware gets
  more efficient. See the methodology section above for the knobs and the
  constants block in `tokens.ts` for the current values.
