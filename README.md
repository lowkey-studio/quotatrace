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

Node 18+. No dependencies. Nothing is uploaded. The report contains counts only: session ids are one-way hashes, and no prompts, paths, file names or outputs appear in it, so you can attach it to an issue or a support ticket.

Example output (from synthetic logs): [test/sample-report.md](test/sample-report.md)

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

QuotaTrace Review, $19: email your report and get back the specific causes, ranked fixes for your setup, and (if the numbers support it) a ready-to-send support ticket, within 6 hours. Details: https://quotatrace.appin60.com

Built by Low Key Studio. MIT licence.
