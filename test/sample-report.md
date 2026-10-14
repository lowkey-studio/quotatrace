# QuotaTrace report

Period: 2026-10-01 00:00 UTC to now · generated 2026-10-14 09:30 UTC · quotatrace 0.4.0

Counts only. Session ids are one-way hashes; no prompts, paths, file names or outputs are included, so you can share this file.

## Codex

2 sessions, 180 model calls, plan reported by Codex: **pro**.

|  | tokens | share |
|---|---|---|
| Input, served from cache | 15.45M | 92.5% |
| Input, not cached | 1.16M | 7.0% |
| Output (incl. reasoning) | 0.09M | 0.5% |
|   of which reasoning | 0.03M | 0.2% |
| **Total** | **16.69M** | 100% |

### Quota used vs tokens, per rate-limit window

"% per 1M" is quota points used per million tokens Codex logged in that window. If the same kind of work suddenly costs several times more quota per million tokens, that is a metering change, not your workload. Only calls logged on this machine are counted; work on other machines or in the cloud also draws on the same quota.

| window | plan | started | quota used | tokens | uncached in + out | % per 1M tokens | % per 1M uncached+out |
|---|---|---|---|---|---|---|---|
| weekly | pro | 2026-10-10 09:00 | 12% → 27% | 16.69M | 1.25M | 0.90 | 12.02 |

### Quota jumps out of line with the tokens behind them

| time (UTC) | window | quota jump | tokens since last step | expected at window average | model |
|---|---|---|---|---|---|
| 2026-10-10 15:20 | weekly | +9% | 123,300 | +0.1% | gpt-6-astra |

### Per day and model

| day | model | calls | tokens | uncached in | output |
|---|---|---|---|---|---|
| 2026-10-10 | gpt-6.1-sol | 120 | 14.21M | 0.99M | 0.05M |
| 2026-10-10 | gpt-6-astra | 60 | 2.49M | 0.17M | 0.04M |

### Where the tokens went

- **Context replay:** every model call re-sends the whole conversation. 91 calls (50.6%) carried 100k+ tokens of context, totalling 12.21M (73.2% of all tokens).
- **Big context, tiny answer:** 31 of those calls produced under 300 output tokens (4.15M of tokens). These are mostly "check status / run one command" steps paid at full-context price.
- **Waiting and polling:** 40 calls (22.2%) followed a sleep / wait / empty-stdin poll, costing 4.77M (28.6%).
- **Compactions:** 0.

### Tool outputs that cost the most (size × times re-sent)

Tool outputs stay in context and are re-sent on every later call until a compaction. Estimated total: 10.50M input tokens came from re-sending earlier tool outputs (estimate: 4 characters ≈ 1 token).

| session | tool | output size (est. tokens) | re-sent | est. tokens re-sent |
|---|---|---|---|---|
| 6f8fee2a | exec | 60,000 | 109× | 6.54M |
| 6f8fee2a | exec | 450 | 119× | 0.05M |
| 6f8fee2a | exec | 450 | 118× | 0.05M |
| 6f8fee2a | sleep | 450 | 117× | 0.05M |
| 6f8fee2a | exec | 450 | 116× | 0.05M |
| 6f8fee2a | exec | 450 | 115× | 0.05M |
| 6f8fee2a | sleep | 450 | 114× | 0.05M |
| 6f8fee2a | exec | 450 | 113× | 0.05M |
| 6f8fee2a | exec | 450 | 112× | 0.05M |
| 6f8fee2a | sleep | 450 | 111× | 0.05M |

### By session kind

Subagents, `exec` runs and any background thread that writes a rollout file are listed separately; all of them draw on the same quota. Background work that writes no rollout file shows up only as quota jumps with no local calls.

| kind (client) | sessions | calls | tokens | share | uncached in |
|---|---|---|---|---|---|
| ? (codex_cli_rs) | 2 | 180 | 16.69M | 100.0% | 1.16M |

### Heaviest sessions

| session | kind | model | effort | calls | tokens | uncached in | peak context | compactions |
|---|---|---|---|---|---|---|---|---|
| 6f8fee2a | ? | gpt-6.1-sol | high | 120 | 14.21M | 0.99M | 167,550 | 0 |
| 1bfc9784 | ? | gpt-6-astra | xhigh | 60 | 2.49M | 0.17M | 63,000 | 0 |

### What to change

- Polling cost 28.6% of tokens. Tell the agent to run long jobs with a single blocking command (or a timeout) instead of sleep/check loops.
- Re-sent tool outputs are a large share. Cap command output (e.g. pipe through `head`/`tail`, use `--quiet`), and avoid dumping whole files or logs into the thread.
- Some quota jumps are far larger than the tokens behind them. Keep this report: the timestamps and token counts are the evidence a support ticket or the openai/codex usage tracker needs.


---
Made by QuotaTrace (https://quotatrace.appin60.com). Want a person to read this report, find the cause and draft your support ticket? See the site.
