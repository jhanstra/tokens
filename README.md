# tokens

A small personal CLI that reports your [Cursor](https://cursor.com) token
usage for the current month and tells you how you're pacing against a goal.
Single file, single dependency (Bun), no state stored in this repo.

It hits the same undocumented endpoint the Cursor dashboard uses
(`/api/dashboard/get-filtered-usage-events`) and aggregates the events into a
terminal-friendly report: totals, today-so-far, monthly goal progress with a
projection, top models by output tokens, and an optional per-day breakdown.

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

Today  (2026-04-16)
─────────────────────
  output 172,515   input 561,952   events 23
  pace  ██████████████████████ 75.9%    of 227,273/work-day share

Monthly goal  (5,000,000 output)
──────────────────────────────────
  ██████████████████▏·············· 56.8%
  progress 2,841,205 / 5,000,000   remaining 2,158,795
  work days 11 left (incl. today) · 11/22 done   pace needed 196,254/work-day
  projection 5,328,009 (106.6% of goal at current work-day pace)

Top models by output
──────────────────────
  model                              out       in   cacheR   cacheW  events  share
  claude-4.6-opus-high-thinking   1.13M    3.57M   114.1M    15.8M    287  ████▌····· 39.8%
  composer-2-fast                854.2k   5.89M    52.1M        0    84  ███▏······ 30.1%
  claude-opus-4-7-max            812.4k   828.3k   75.6M    4.16M    38  ██▉······· 28.6%
  …
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
| `--no-color` | Disable ANSI colors. |
| `-v`, `--verbose` | Log each API page as it paginates. |
| `-h`, `--help` | Show help. |

Token precedence: `CURSOR_SESSION_TOKEN` env var beats the cached file.

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
