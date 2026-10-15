# QuotaTrace

**Where did my Codex / Claude Code quota go?**

QuotaTrace reads the session logs Codex and Claude Code already keep on your machine and writes a report that answers:

- How many quota points did each rate-limit window cost, per million tokens? (Codex logs your plan's `used_percent` next to every call, so QuotaTrace can line them up.)
- Which quota jumps were far larger than the tokens behind them? Those timestamps are the evidence a support ticket needs.
- How much went on context replay, big-context calls that did almost nothing, sleep/wait polling, and tool outputs re-sent on every later call?
- For Claude Code: cache writes, cache rebuilt after a pause, subagent share, and the tool results that were re-read the most.

```sh
npx github:lowkey-studio/quotatrace            # last 7 days, writes ./quotatrace-report.md
npx github:lowkey-studio/quotatrace --since 30d
npx github:lowkey-studio/quotatrace --only codex --since 2026-10-01
```

No git installed? `npx https://codeload.github.com/lowkey-studio/quotatrace/tar.gz/refs/heads/main` works too.

No terminal? Use the browser version at https://quotatrace.appin60.com/app.html: pick your logs folder, and the analysis runs inside the page with nothing uploaded.

Node 18+. No dependencies. Nothing is uploaded. The report contains counts only: session ids are one-way hashes, and no prompts, paths, file names or outputs appear in it, so you can attach it to an issue or a support ticket.

Example output (from synthetic logs): [test/sample-report.md](test/sample-report.md)

## Live burn rate

```sh
npx github:lowkey-studio/quotatrace live            # refreshes every 5 s, last 10 minutes
```

```
QUOTA WINDOW    USED   PTS/HOUR  EMPTY IN
codex 5h        58%    36.0      1.2 h
codex week      66%    12.0      2.8 h

SESSION   TOOL    MODEL                 TOK/MIN  CALLS  CONTEXT  CACHE HIT
d86c9e70  claude  claude-opus-5-5       1.3M     7      356k     100%
```

Per running session: tokens per minute, calls, current context size and the last call's prompt-cache hit rate. Per quota window: points used per hour over the last 30 minutes and the projected time until it's empty (or "resets first"). Codex quota readings come from its logs; for Claude Code run `meter install` first. Options: `--window <min>`, `--interval <sec>`, `--once`.

## Trust and privacy

You shouldn't have to take a stranger's word for what a tool does with your logs, so it's built to be checked:

- **No network access.** `bin/quotatrace.mjs` and `bin/core.mjs` import only `fs`, `path`, `os` and `readline` (and `bin/live.mjs` the same minus `readline`); there is no `fetch`, `http`, `net` or `child_process` in them. Check with `grep -nE "^import|fetch\(" bin/quotatrace.mjs bin/core.mjs` (the only URLs in the code are links printed in the report). (`bin/meter.mjs` uses `child_process` only to run *your own* previous status line command.)
- **Small and readable.** About 600 lines of plain JavaScript, no dependencies, nothing minified. Read it before you run it, or pin a commit: `npx github:lowkey-studio/quotatrace#<commit>`.
- **Read-only.** It reads `.jsonl` logs and writes one report file. Only `meter install` changes anything (your Claude `settings.json`, backed up first).
- **The browser version** reads the folder you pick inside the page. Load it, disconnect from the network, and it still works.
- **The report holds counts only**, so check it before sharing: no prompts, paths, file names or outputs.

## Claude Code quota percentage (optional meter)

Claude Code transcripts log tokens but not your plan's usage percentage. Two ways to record it from now on:

```sh
npx github:lowkey-studio/quotatrace record    # leave running: logs the utilization snapshot Claude Code caches in ~/.claude.json; changes nothing
```

or, for a reading on every status line refresh:

```sh
npx github:lowkey-studio/quotatrace meter install     # adds a status line hook, keeps your current status line
npx github:lowkey-studio/quotatrace meter uninstall   # restores your previous status line
```

The hook copies a 50-line script to `~/.quotatrace/meter.mjs`, backs up `~/.claude/settings.json`, and appends `rate_limits` snapshots (5-hour, weekly and per-model windows) to `~/.quotatrace/claude-limits.jsonl` whenever they change. Later reports then show quota points per 1M tokens and out-of-line jumps for Claude Code too.

## Options

| flag | meaning |
|---|---|
| `--since 7d \| 24h \| YYYY-MM-DD` | period (default 7d) |
| `--until YYYY-MM-DD` | end of period |
| `--only codex \| claude` | one tool only |
| `--out FILE` | report path |
| `--top N` | rows in top tables |
| `--json` | also write `quotatrace-summary.json` |
| `--share` | print a link to a prefilled GitHub issue with your anonymous per-window numbers, for the public quota dataset (you review it before posting) |
| `--codex-home`, `--claude-home` | non-default locations (`$CODEX_HOME`, `$CLAUDE_CONFIG_DIR` are honoured) |

## How to read "% per 1M tokens"

For each Codex rate-limit window (5-hour, weekly), QuotaTrace takes the quota points used (max − min `used_percent` seen in your logs) and divides by the tokens logged in that window. Comparable work should cost a comparable number of points per million tokens. A sudden multiple, on the same plan and model, points at a metering change rather than your workload. Caveats: only calls logged on this machine are counted (other machines, cloud tasks and background features draw on the same quota), and `used_percent` is reported in whole points, so short windows are noisy.

## Contribute your numbers

`quotatrace --share` opens a prefilled issue with per-window aggregates only (date, window, plan, points used, thousands of tokens). With enough of them we can show, per plan and model, what a quota point buys and when that changed.

## Want a person to read your report?

The paid review is closed for now.

Built by Low Key Studio. MIT licence.
