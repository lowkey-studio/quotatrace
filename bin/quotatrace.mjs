#!/usr/bin/env node
// QuotaTrace: explain where your Codex / Claude Code quota went.
// Reads local session logs only. Never uploads anything. Prints token counts, never prompt or file content.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';

const VERSION = '0.3.0';
const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (args.version) { console.log(VERSION); process.exit(0); }

const sinceMs = parseSince(args.since || '7d');
const untilMs = args.until ? Date.parse(args.until) : Infinity;
const TOP = Number(args.top || 10);
const codexHome = args['codex-home'] || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const claudeHome = args['claude-home'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
if (process.argv[2] === 'meter') { meterCmd(process.argv[3]); process.exit(0); }

const fmt = n => (n == null || Number.isNaN(n)) ? '-' : Math.round(n).toLocaleString('en-US');
const mt = n => (n / 1e6).toFixed(2) + 'M';
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
const sid = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const day = ms => new Date(ms).toISOString().slice(0, 10);
const POLL_TOOLS = new Set(['sleep', 'wait', 'wait_agent', 'list_agents']);

function usage() {
  console.log(`quotatrace ${VERSION} - where did my Codex / Claude Code quota go?

Usage: npx github:lowkey-studio/quotatrace [options]

  --since 7d|24h|YYYY-MM-DD   period to analyse (default 7d)
  --until YYYY-MM-DD          end of period (default now)
  --only codex|claude         analyse one tool only
  --out FILE                  report path (default ./quotatrace-report.md)
  --top N                     rows in "top" tables (default 10)
  --json                      also write quotatrace-summary.json
  --share                     print a link that opens a prefilled GitHub issue with
                              your anonymous per-day numbers (you review it before posting)
  --codex-home DIR            default $CODEX_HOME or ~/.codex
  --claude-home DIR           default $CLAUDE_CONFIG_DIR or ~/.claude

Claude Code does not log your plan's usage percentage in its transcripts. To record it from now on:
  npx github:lowkey-studio/quotatrace meter install     (adds a status line hook; keeps your old one)
  npx github:lowkey-studio/quotatrace meter uninstall

Everything runs locally. The report holds counts only: no prompts, paths or file names.`);
}

function meterCmd(action) {
  const qdir = path.join(os.homedir(), '.quotatrace');
  const settingsPath = path.join(claudeHome, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { if (fs.existsSync(settingsPath)) { console.error('Could not parse ' + settingsPath + '; not changing it.'); process.exit(1); } }
  const meterPath = path.join(qdir, 'meter.mjs');
  const ours = c => typeof c === 'string' && c.includes('.quotatrace');
  if (action === 'install') {
    fs.mkdirSync(qdir, { recursive: true });
    fs.copyFileSync(new URL('./meter.mjs', import.meta.url), meterPath);
    const cur = settings.statusLine && settings.statusLine.command;
    if (cur && !ours(cur)) fs.writeFileSync(path.join(qdir, 'wrapped-statusline'), cur);
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.quotatrace-backup');
    settings.statusLine = { ...(settings.statusLine || {}), type: 'command', command: `node "${meterPath}"` };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`Installed. Claude Code will log rate-limit snapshots to ${path.join(qdir, 'claude-limits.jsonl')} on each status line refresh.` + (cur && !ours(cur) ? `\nYour previous status line (${cur}) still renders.` : '') + `\nBackup of your settings: ${settingsPath}.quotatrace-backup\nRun quotatrace again after some use to see quota points per 1M tokens for Claude Code.`);
  } else if (action === 'uninstall') {
    let wrapped = ''; try { wrapped = fs.readFileSync(path.join(qdir, 'wrapped-statusline'), 'utf8').trim(); } catch {}
    if (settings.statusLine && ours(settings.statusLine.command)) {
      if (wrapped) settings.statusLine.command = wrapped; else delete settings.statusLine;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    try { fs.unlinkSync(path.join(qdir, 'wrapped-statusline')); } catch {}
    console.log('Removed the QuotaTrace status line hook' + (wrapped ? ' and restored your previous one.' : '.') + ' Recorded snapshots stay in ' + qdir);
  } else console.log('usage: quotatrace meter install | uninstall');
}

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    if (['help', 'version', 'json', 'share'].includes(key)) o[key] = true;
    else o[key] = a[++i];
  }
  if (a.includes('-h')) o.help = true;
  return o;
}

function parseSince(s) {
  const m = /^(\d+)([dh])$/.exec(s);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'd' ? 864e5 : 36e5);
  const t = Date.parse(s);
  if (Number.isNaN(t)) { console.error('bad --since'); process.exit(1); }
  return t;
}

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { continue; } }
    if (isDir) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    fn(d);
  }
}

function outLen(o) {
  if (o == null) return 0;
  if (typeof o === 'string') return o.length;
  if (Array.isArray(o)) return o.reduce((s, x) => s + outLen(x), 0);
  if (typeof o === 'object') {
    if (o.type === 'image' || o.type === 'input_image' || o.type === 'document') return 6000; // ~1.5k tokens, not the base64 size
    if (typeof o.text === 'string') return o.text.length;
    if (o.output !== undefined) return outLen(o.output);
    if (o.content !== undefined) return outLen(o.content);
    return JSON.stringify(o).length;
  }
  return String(o).length;
}

// ---------------- Codex ----------------
async function analyseCodex() {
  const files = [...walk(path.join(codexHome, 'sessions')), ...walk(path.join(codexHome, 'archived_sessions'))];
  const calls = [], snaps = [], tools = [], sessions = new Map();
  let compactions = 0;
  for (const f of files) {
    try { if (fs.statSync(f).mtimeMs < sinceMs) continue; } catch { continue; }
    const S = { id: sid(f), model: '?', effort: '', origin: '', calls: 0, tokens: 0, uncached: 0, peak: 0, compactions: 0 };
    const local = [];           // calls in this file, in order
    const fileTools = [];       // tool outputs in this file
    let lastTotal = null, pendingPoll = false, lastToolName = null;
    await eachLine(f, d => {
      const ts = Date.parse(d.timestamp || '') || 0;
      const p = (d.payload && typeof d.payload === 'object') ? d.payload : {};
      if (d.type === 'session_meta') { S.origin = p.originator || p.source || ''; S.cli = p.cli_version || ''; return; }
      if (d.type === 'turn_context') { S.model = p.model || S.model; S.effort = p.effort || p.reasoning_effort || S.effort; return; }
      if (d.type === 'compacted' || (d.type === 'event_msg' && /compact/i.test(p.type || ''))) {
        if (d.type === 'compacted') { compactions++; S.compactions++; local.push({ compaction: true, ts }); }
        return;
      }
      if (d.type === 'response_item') {
        const t = p.type || '';
        if (t.endsWith('_call') && !t.endsWith('_output')) {
          let name = p.name || t.replace(/_call$/, '');
          let argstr = typeof p.arguments === 'string' ? p.arguments : (typeof p.input === 'string' ? p.input : '');
          let poll = POLL_TOOLS.has(name) || /^\s*\{?\s*"?(cmd|command)"?\s*[:=]\s*\[?\s*"?(sleep|timeout)\b/.test(argstr) || /^\s*sleep\s+\d/.test(argstr);
          if (name === 'write_stdin' && /"chars"\s*:\s*""/.test(argstr)) poll = true;
          pendingPoll = poll; lastToolName = name;
          return;
        }
        if (t.endsWith('_call_output')) {
          const chars = outLen(p.output);
          fileTools.push({ name: lastToolName || t.replace(/_call_output$/, ''), est: Math.round(chars / 4), at: local.length, ts });
          return;
        }
        return;
      }
      if (d.type === 'event_msg' && p.type === 'token_count') {
        if (!ts || ts < sinceMs || ts > untilMs) return;
        const info = p.info || null;
        let call = null;
        if (info && info.total_token_usage) {
          const tot = info.total_token_usage.total_tokens;
          if (tot !== lastTotal) {
            lastTotal = tot;
            const u = info.last_token_usage || {};
            const input = u.input_tokens || 0, cached = u.cached_input_tokens || 0;
            call = {
              ts, session: S.id, model: S.model, effort: S.effort,
              input, cached, uncached: Math.max(0, input - cached), cacheWrite: u.cache_write_input_tokens || 0,
              output: u.output_tokens || 0, reasoning: u.reasoning_output_tokens || 0,
              total: u.total_tokens || (input + (u.output_tokens || 0)), poll: pendingPoll,
            };
            pendingPoll = false;
            calls.push(call); local.push(call);
            S.calls++; S.tokens += call.total; S.uncached += call.uncached; S.peak = Math.max(S.peak, input);
          }
        }
        const rl = p.rate_limits;
        if (rl) {
          for (const which of ['primary', 'secondary']) {
            const w = rl[which];
            if (!w || w.used_percent == null) continue;
            snaps.push({ ts, key: `${rl.limit_id || 'codex'}|${rl.plan_type || '?'}|${w.window_minutes}|${Math.round((w.resets_at || 0) / 900)}`, window: w.window_minutes, resets: w.resets_at, used: w.used_percent, plan: rl.plan_type || '?', call, credits: rl.credits && rl.credits.balance });
          }
        }
      }
    });
    // replay cost of each tool output: re-sent as input on every later call until a compaction
    for (const t of fileTools) {
      let n = 0;
      for (let i = t.at; i < local.length; i++) { if (local[i].compaction) break; n++; }
      t.replays = Math.max(0, n - 1); t.replayTokens = t.est * t.replays; t.session = S.id; t.model = S.model;
      tools.push(t);
    }
    if (S.calls) sessions.set(S.id, S);
  }
  return { files: files.length, calls, snaps, tools, sessions, compactions };
}

function quotaAnalysis(c) {
  const byKey = new Map();
  c.snaps.sort((a, b) => a.ts - b.ts);
  for (const s of c.snaps) {
    let k = byKey.get(s.key);
    if (!k) { k = { key: s.key, window: s.window, resets: s.resets, plan: s.plan, first: s.used, last: s.used, min: s.used, max: s.used, firstTs: s.ts, lastTs: s.ts, tokens: 0, uncached: 0, output: 0, cached: 0, steps: [], prev: s.used, pendingTok: 0, pendingUnc: 0 }; byKey.set(s.key, k); }
    if (s.call && !s._counted) {
      k.tokens += s.call.total; k.uncached += s.call.uncached; k.output += s.call.output; k.cached += s.call.cached;
      k.pendingTok += s.call.total; k.pendingUnc += s.call.uncached;
    }
    const delta = s.used - k.prev;
    if (delta > 0) {
      k.steps.push({ ts: s.ts, delta, tokens: k.pendingTok, uncached: k.pendingUnc, model: s.call ? s.call.model : '' });
      k.pendingTok = 0; k.pendingUnc = 0;
    }
    k.prev = s.used; k.last = s.used; k.lastTs = s.ts; k.max = Math.max(k.max, s.used); k.min = Math.min(k.min, s.used);
  }
  const windows = [...byKey.values()].filter(k => k.tokens > 0 || k.max > k.min).map(k => {
    const used = k.max - k.min;
    return { ...k, used, perM: k.tokens ? used / (k.tokens / 1e6) : null, perMUnc: k.uncached ? used / ((k.uncached + k.output) / 1e6) : null };
  }).sort((a, b) => a.firstTs - b.firstTs);
  // spikes: quota steps that are large relative to the window's own average rate
  const spikes = [];
  for (const w of windows) {
    if (!w.perM) continue;
    for (const st of w.steps) {
      const expected = st.tokens / 1e6 * w.perM;
      if (st.delta >= 2 && st.delta > 3 * Math.max(expected, 0.34)) spikes.push({ ...st, window: w.window, perM: w.perM, expected });
    }
  }
  spikes.sort((a, b) => b.delta - a.delta);
  return { windows, spikes };
}

// ---------------- Claude Code ----------------
async function analyseClaude() {
  const files = walk(path.join(claudeHome, 'projects'));
  const calls = [], tools = [], sessions = new Map();
  const seen = new Set();
  for (const f of files) {
    try { if (fs.statSync(f).mtimeMs < sinceMs) continue; } catch { continue; }
    const S = { id: sid(f), model: '?', calls: 0, tokens: 0, peak: 0, sidechain: /subagents/.test(f) };
    const local = [], fileTools = [], toolNames = new Map();
    await eachLine(f, d => {
      const ts = Date.parse(d.timestamp || '') || 0;
      if (d.type === 'summary' || d.isCompactSummary) { local.push({ compaction: true, ts }); return; }
      const m = d.message;
      if (!m || typeof m !== 'object') return;
      if (d.type === 'assistant' && m.usage) {
        if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') toolNames.set(b.id, b.name);
        const key = (m.id || '') + ':' + (d.requestId || '');
        if (m.id && seen.has(key)) return;
        seen.add(key);
        if (!ts || ts < sinceMs || ts > untilMs) return;
        if (m.model === '<synthetic>') return;
        const u = m.usage;
        const cc = u.cache_creation || {};
        const call = {
          ts, session: S.id, model: m.model || '?', sidechain: !!d.isSidechain || S.sidechain,
          input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
          write1h: cc.ephemeral_1h_input_tokens || 0, write5m: cc.ephemeral_5m_input_tokens || 0,
          output: u.output_tokens || 0,
        };
        call.ctx = call.input + call.cacheRead + call.cacheWrite;
        call.total = call.ctx + call.output;
        calls.push(call); local.push(call);
        S.model = call.model; S.calls++; S.tokens += call.total; S.peak = Math.max(S.peak, call.ctx);
        return;
      }
      if (d.type === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_result') fileTools.push({ name: toolNames.get(b.tool_use_id) || 'tool', est: Math.round(outLen(b.content) / 4), at: local.length, ts });
        }
      }
    });
    for (const t of fileTools) {
      let n = 0;
      for (let i = t.at; i < local.length; i++) { if (local[i].compaction) break; n++; }
      t.replays = Math.max(0, n - 1); t.replayTokens = t.est * t.replays; t.session = S.id;
      if (t.ts >= sinceMs) tools.push(t);
    }
    // idle cache rebuilds: a big cache write after the cache had time to expire
    const cs = local.filter(x => !x.compaction);
    for (let i = 1; i < cs.length; i++) {
      const gap = (cs[i].ts - cs[i - 1].ts) / 60000;
      cs[i].gap = gap;
      cs[i].idleRebuild = cs[i].cacheWrite > 20000 && cs[i].cacheRead < cs[i].cacheWrite && ((cs[i].write5m > 0 && gap > 5) || gap > 60);
    }
    if (S.calls) sessions.set(S.id, S);
  }
  return { files: files.length, calls, tools, sessions };
}

function claudeQuota(cl) {
  const f = args['meter-file'] || path.join(os.homedir(), '.quotatrace', 'claude-limits.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; }
  const snaps = [];
  for (const l of lines) {
    const ts = Date.parse(l.ts); if (!ts || ts < sinceMs || ts > untilMs) continue;
    for (const [name, [used, resets]] of Object.entries(l.w || {})) snaps.push({ ts, name, used, key: name + '|' + Math.round((Number(resets) || 0) / 900) });
  }
  if (!snaps.length) return { windows: [], spikes: [], snaps: 0 };
  snaps.sort((a, b) => a.ts - b.ts);
  const calls = cl.calls.slice().sort((a, b) => a.ts - b.ts);
  const sumBetween = (t0, t1) => { let tot = 0, bill = 0; for (const c of calls) { if (c.ts <= t0) continue; if (c.ts > t1) break; tot += c.total; bill += c.input + c.cacheWrite + c.output; } return { tot, bill }; };
  const byKey = new Map();
  for (const s of snaps) {
    let k = byKey.get(s.key);
    if (!k) { k = { name: s.name, firstTs: s.ts, lastTs: s.ts, min: s.used, max: s.used, prev: s.used, prevTs: s.ts, steps: [] }; byKey.set(s.key, k); continue; }
    if (s.used > k.prev) { const t = sumBetween(k.prevTs, s.ts); k.steps.push({ ts: s.ts, delta: s.used - k.prev, tokens: t.tot }); }
    k.prev = s.used; k.prevTs = s.ts; k.lastTs = s.ts; k.min = Math.min(k.min, s.used); k.max = Math.max(k.max, s.used);
  }
  const windows = [...byKey.values()].map(k => { const t = sumBetween(k.firstTs, k.lastTs); const used = k.max - k.min; return { ...k, used, tokens: t.tot, bill: t.bill, perM: t.tot ? used / (t.tot / 1e6) : null, perMBill: t.bill ? used / (t.bill / 1e6) : null }; }).filter(w => w.used > 0 || w.tokens > 0).sort((a, b) => a.firstTs - b.firstTs);
  const spikes = [];
  for (const w of windows) { if (!w.perM) continue; for (const st of w.steps) { const expected = st.tokens / 1e6 * w.perM; if (st.delta >= 2 && st.delta > 3 * Math.max(expected, 0.34)) spikes.push({ ...st, window: w.name, expected }); } }
  spikes.sort((a, b) => b.delta - a.delta);
  return { windows, spikes, snaps: snaps.length };
}

// ---------------- report ----------------
function table(head, rows) {
  if (!rows.length) return '_none_\n';
  return `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n` + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';
}
const winName = m => m == null ? '?' : m === 300 ? '5-hour' : m === 10080 ? 'weekly' : m >= 1440 ? `${Math.round(m / 1440)}-day` : `${m}-min`;

function codexSection(c, q) {
  const L = [];
  const T = c.calls.reduce((a, x) => { a.input += x.input; a.cached += x.cached; a.unc += x.uncached; a.out += x.output; a.rea += x.reasoning; a.tot += x.total; return a; }, { input: 0, cached: 0, unc: 0, out: 0, rea: 0, tot: 0 });
  L.push(`## Codex\n`);
  if (!c.calls.length) { L.push(`No Codex model calls found in this period (looked in \`${path.join('~', path.relative(os.homedir(), codexHome))}/sessions\`).\n`); return L.join('\n'); }
  const plans = [...new Set(c.snaps.map(s => s.plan))].join(', ') || 'unknown';
  L.push(`${c.sessions.size} sessions, ${fmt(c.calls.length)} model calls, plan reported by Codex: **${plans}**.\n`);
  L.push(table(['', 'tokens', 'share'], [
    ['Input, served from cache', mt(T.cached), pct(T.cached, T.tot)],
    ['Input, not cached', mt(T.unc), pct(T.unc, T.tot)],
    ['Output (incl. reasoning)', mt(T.out), pct(T.out, T.tot)],
    ['  of which reasoning', mt(T.rea), pct(T.rea, T.tot)],
    ['**Total**', `**${mt(T.tot)}**`, '100%'],
  ]));

  L.push(`### Quota used vs tokens, per rate-limit window\n`);
  L.push(`"% per 1M" is quota points used per million tokens Codex logged in that window. If the same kind of work suddenly costs several times more quota per million tokens, that is a metering change, not your workload. Only calls logged on this machine are counted; work on other machines or in the cloud also draws on the same quota.\n`);
  L.push(table(['window', 'plan', 'started', 'quota used', 'tokens', 'uncached in + out', '% per 1M tokens', '% per 1M uncached+out'],
    q.windows.slice(-40).map(w => [winName(w.window), w.plan, new Date(w.firstTs).toISOString().slice(0, 16).replace('T', ' '), `${w.min}% → ${w.max}%`, mt(w.tokens), mt(w.uncached + w.output), w.perM == null ? '-' : w.perM.toFixed(2), w.perMUnc == null ? '-' : w.perMUnc.toFixed(2)])));

  L.push(`### Quota jumps out of line with the tokens behind them\n`);
  L.push(table(['time (UTC)', 'window', 'quota jump', 'tokens since last step', 'expected at window average', 'model'],
    q.spikes.slice(0, TOP).map(s => [new Date(s.ts).toISOString().slice(0, 16).replace('T', ' '), winName(s.window), `+${s.delta}%`, s.tokens ? fmt(s.tokens) : '0 (no local calls: another device, cloud task or background use)', `+${s.expected.toFixed(1)}%`, s.model || '-'])));

  // where tokens went
  const byDay = new Map();
  for (const x of c.calls) { const k = day(x.ts) + '|' + x.model; const r = byDay.get(k) || { d: day(x.ts), model: x.model, n: 0, tot: 0, unc: 0, out: 0 }; r.n++; r.tot += x.total; r.unc += x.uncached; r.out += x.output; byDay.set(k, r); }
  L.push(`### Per day and model\n`);
  L.push(table(['day', 'model', 'calls', 'tokens', 'uncached in', 'output'], [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d)).map(r => [r.d, r.model, fmt(r.n), mt(r.tot), mt(r.unc), mt(r.out)])));

  const big = c.calls.filter(x => x.input >= 100000);
  const bigLow = big.filter(x => x.output < 300);
  const polls = c.calls.filter(x => x.poll);
  const pollTok = polls.reduce((s, x) => s + x.total, 0);
  L.push(`### Where the tokens went\n`);
  L.push(`- **Context replay:** every model call re-sends the whole conversation. ${fmt(big.length)} calls (${pct(big.length, c.calls.length)}) carried 100k+ tokens of context, totalling ${mt(big.reduce((s, x) => s + x.total, 0))} (${pct(big.reduce((s, x) => s + x.total, 0), T.tot)} of all tokens).`);
  L.push(`- **Big context, tiny answer:** ${fmt(bigLow.length)} of those calls produced under 300 output tokens (${mt(bigLow.reduce((s, x) => s + x.total, 0))} of tokens). These are mostly "check status / run one command" steps paid at full-context price.`);
  L.push(`- **Waiting and polling:** ${fmt(polls.length)} calls (${pct(polls.length, c.calls.length)}) followed a sleep / wait / empty-stdin poll, costing ${mt(pollTok)} (${pct(pollTok, T.tot)}).`);
  L.push(`- **Compactions:** ${c.compactions}.\n`);

  const topTools = c.tools.filter(t => t.est > 0).sort((a, b) => b.replayTokens - a.replayTokens).slice(0, TOP);
  const allReplay = c.tools.reduce((s, t) => s + t.replayTokens, 0);
  L.push(`### Tool outputs that cost the most (size × times re-sent)\n`);
  L.push(`Tool outputs stay in context and are re-sent on every later call until a compaction. Estimated total: ${mt(allReplay)} input tokens came from re-sending earlier tool outputs (estimate: 4 characters ≈ 1 token).\n`);
  L.push(table(['session', 'tool', 'output size (est. tokens)', 're-sent', 'est. tokens re-sent'], topTools.map(t => [t.session, t.name, fmt(t.est), fmt(t.replays) + '×', mt(t.replayTokens)])));

  L.push(`### Heaviest sessions\n`);
  L.push(table(['session', 'model', 'effort', 'calls', 'tokens', 'uncached in', 'peak context', 'compactions'],
    [...c.sessions.values()].sort((a, b) => b.tokens - a.tokens).slice(0, TOP).map(s => [s.id, s.model, s.effort || '-', fmt(s.calls), mt(s.tokens), mt(s.uncached), fmt(s.peak), s.compactions])));

  const tips = [];
  if (bigLow.length > c.calls.length * 0.2) tips.push('Many full-context calls do almost nothing. Start a fresh thread per task, or hand long-running waits to a script instead of letting the agent poll.');
  if (pollTok > T.tot * 0.05) tips.push(`Polling cost ${pct(pollTok, T.tot)} of tokens. Tell the agent to run long jobs with a single blocking command (or a timeout) instead of sleep/check loops.`);
  if (allReplay > T.tot * 0.2 && topTools.length) tips.push(`Re-sent tool outputs are a large share. Cap command output (e.g. pipe through \`head\`/\`tail\`, use \`--quiet\`), and avoid dumping whole files or logs into the thread.`);
  if (q.spikes.length) tips.push('Some quota jumps are far larger than the tokens behind them. Keep this report: the timestamps and token counts are the evidence a support ticket or the openai/codex usage tracker needs.');
  if (T.unc > T.tot * 0.3) tips.push(`Uncached input is ${pct(T.unc, T.tot)} of tokens. Cache misses happen after long pauses and after edits to early context (instructions, AGENTS.md, tool lists) mid-session.`);
  if (tips.length) L.push(`### What to change\n\n` + tips.map(t => '- ' + t).join('\n') + '\n');
  return L.join('\n');
}

function claudeSection(c) {
  const L = [];
  L.push(`## Claude Code\n`);
  if (!c.calls.length) { L.push(`No Claude Code model calls found in this period (looked in \`${path.join('~', path.relative(os.homedir(), claudeHome))}/projects\`).\n`); return L.join('\n'); }
  const T = c.calls.reduce((a, x) => { a.inp += x.input; a.r += x.cacheRead; a.w += x.cacheWrite; a.w1 += x.write1h; a.o += x.output; a.t += x.total; if (x.sidechain) a.side += x.total; return a; }, { inp: 0, r: 0, w: 0, w1: 0, o: 0, t: 0, side: 0 });
  const cq = claudeQuota(c);
  L.push(`${c.sessions.size} transcripts, ${fmt(c.calls.length)} model calls.`);
  if (cq && cq.windows.length) {
    L.push(`### Quota used vs tokens (from the QuotaTrace meter, ${fmt(cq.snaps)} snapshots)\n`);
    L.push(`"billable" = uncached input + cache writes + output; cache reads are excluded because they are a small fraction of the price. Only calls logged on this machine are counted.\n`);
    L.push(table(['window', 'started', 'quota used', 'tokens', 'billable tokens', '% per 1M tokens', '% per 1M billable'], cq.windows.slice(-40).map(w => [w.name, new Date(w.firstTs).toISOString().slice(0, 16).replace('T', ' '), `${w.min}% → ${w.max}%`, mt(w.tokens), mt(w.bill), w.perM == null ? '-' : w.perM.toFixed(2), w.perMBill == null ? '-' : w.perMBill.toFixed(2)])));
    L.push(`### Quota jumps out of line with the tokens behind them\n`);
    L.push(table(['time (UTC)', 'window', 'quota jump', 'tokens since last step', 'expected at window average'], cq.spikes.slice(0, TOP).map(s => [new Date(s.ts).toISOString().slice(0, 16).replace('T', ' '), s.window, `+${s.delta}%`, s.tokens ? fmt(s.tokens) : '0 (no local calls)', `+${s.expected.toFixed(1)}%`])));
  } else {
    L.push(`Claude Code does not write your plan's usage percentage into transcripts. Run \`npx github:lowkey-studio/quotatrace meter install\` once to start recording it from the status line; later reports will then show quota points per 1M tokens and out-of-line jumps here.\n`);
  }
  L.push(`### Tokens\n\nThe section below shows tokens. On the API, cache writes cost 1.25× (5-minute) or 2× (1-hour) the input price and cache reads 0.1×, so writes and output dominate cost.\n`);
  L.push(table(['', 'tokens', 'share'], [
    ['Cache reads', mt(T.r), pct(T.r, T.t)],
    ['Cache writes', mt(T.w), pct(T.w, T.t)],
    ['  of which 1-hour cache', mt(T.w1), pct(T.w1, T.t)],
    ['Uncached input', mt(T.inp), pct(T.inp, T.t)],
    ['Output', mt(T.o), pct(T.o, T.t)],
    ['Subagent calls (all kinds)', mt(T.side), pct(T.side, T.t)],
    ['**Total**', `**${mt(T.t)}**`, '100%'],
  ]));
  const byDay = new Map();
  for (const x of c.calls) { const k = day(x.ts) + '|' + x.model; const r = byDay.get(k) || { d: day(x.ts), model: x.model, n: 0, t: 0, w: 0, o: 0 }; r.n++; r.t += x.total; r.w += x.cacheWrite; r.o += x.output; byDay.set(k, r); }
  L.push(`### Per day and model\n`);
  L.push(table(['day', 'model', 'calls', 'tokens', 'cache writes', 'output'], [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d)).map(r => [r.d, r.model, fmt(r.n), mt(r.t), mt(r.w), mt(r.o)])));
  const idle = c.calls.filter(x => x.idleRebuild);
  const idleW = idle.reduce((s, x) => s + x.cacheWrite, 0);
  const big = c.calls.filter(x => x.ctx >= 100000);
  L.push(`### Where the tokens went\n`);
  L.push(`- **Cache rebuilt after a pause:** ${fmt(idle.length)} calls re-wrote the context to cache after it expired (gap longer than the cache lifetime), writing ${mt(idleW)} tokens (${pct(idleW, T.w)} of all cache writes).`);
  L.push(`- **Context replay:** ${fmt(big.length)} calls (${pct(big.length, c.calls.length)}) carried 100k+ tokens of context.`);
  const allReplay = c.tools.reduce((s, t) => s + t.replayTokens, 0);
  L.push(`- **Re-sent tool results:** about ${mt(allReplay)} tokens of context came from tool results re-read on later calls.\n`);
  const topTools = c.tools.filter(t => t.est > 0).sort((a, b) => b.replayTokens - a.replayTokens).slice(0, TOP);
  L.push(`### Tool results that cost the most (size × times re-read)\n`);
  L.push(table(['transcript', 'tool', 'result size (est. tokens)', 're-read', 'est. tokens re-read'], topTools.map(t => [t.session, t.name, fmt(t.est), fmt(t.replays) + '×', mt(t.replayTokens)])));
  const byTool = new Map();
  for (const t of c.tools) { const r = byTool.get(t.name) || { n: 0, est: 0, rep: 0 }; r.n++; r.est += t.est; r.rep += t.replayTokens; byTool.set(t.name, r); }
  L.push(`### By tool\n`);
  L.push(table(['tool', 'results', 'total size (est. tokens)', 'est. tokens re-read'], [...byTool.entries()].sort((a, b) => b[1].rep - a[1].rep).slice(0, TOP).map(([k, r]) => [k, fmt(r.n), mt(r.est), mt(r.rep)])));
  L.push(`### Heaviest transcripts\n`);
  L.push(table(['transcript', 'model', 'calls', 'tokens', 'peak context'], [...c.sessions.values()].sort((a, b) => b.tokens - a.tokens).slice(0, TOP).map(s => [s.id + (s.sidechain ? ' (subagent)' : ''), s.model, fmt(s.calls), mt(s.tokens), fmt(s.peak)])));
  const tips = [];
  if (idleW > T.w * 0.15) tips.push(`Pauses cost you ${pct(idleW, T.w)} of cache writes. Finish a thread before a break, or /clear and restart small instead of resuming a huge context after lunch.`);
  if (allReplay > T.t * 0.2) tips.push('Large tool results get re-read on every turn. Ask for targeted reads (line ranges, grep) and cap command output.');
  if (T.side > T.t * 0.3) tips.push(`Subagents used ${pct(T.side, T.t)} of tokens. Each one re-reads its own context; use them for genuinely parallel or isolating work.`);
  if (tips.length) L.push(`### What to change\n\n` + tips.map(t => '- ' + t).join('\n') + '\n');
  return L.join('\n');
}

function shareSummary(c, q, cl) {
  const days = new Map();
  if (c) for (const w of q.windows) {
    if (w.window !== 10080 && w.window !== 300) continue;
    const k = day(w.firstTs) + '|' + w.window;
    const r = days.get(k) || { d: day(w.firstTs), w: w.window, plan: w.plan, used: 0, tok: 0, unc: 0, out: 0 };
    r.used += w.used; r.tok += w.tokens; r.unc += w.uncached; r.out += w.output; days.set(k, r);
  }
  const models = c ? [...new Set(c.calls.map(x => x.model + (x.effort ? '/' + x.effort : '')))].slice(0, 6) : [];
  return { v: VERSION, models, codex_windows: [...days.values()].map(r => [r.d, r.w, r.plan, +r.used.toFixed(1), Math.round(r.tok / 1e3), Math.round(r.unc / 1e3), Math.round(r.out / 1e3)]), claude_calls: cl ? cl.calls.length : 0 };
}

(async () => {
  const doCodex = args.only !== 'claude', doClaude = args.only !== 'codex';
  const c = doCodex ? await analyseCodex() : null;
  const q = c ? quotaAnalysis(c) : null;
  const cl = doClaude ? await analyseClaude() : null;
  const out = args.out || 'quotatrace-report.md';
  const head = `# QuotaTrace report\n\nPeriod: ${new Date(sinceMs).toISOString().slice(0, 16).replace('T', ' ')} UTC to ${untilMs === Infinity ? 'now' : new Date(untilMs).toISOString().slice(0, 16)} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · quotatrace ${VERSION}\n\nCounts only. Session ids are one-way hashes; no prompts, paths, file names or outputs are included, so you can share this file.\n`;
  const body = [head, c ? codexSection(c, q) : '', cl ? claudeSection(cl) : '',
    `---\nMade by QuotaTrace (https://quotatrace.appin60.com). Want a person to read this report, find the cause and draft your support ticket? See the site.\n`].join('\n');
  fs.writeFileSync(out, body);
  const sum = shareSummary(c, q, cl);
  if (args.json) fs.writeFileSync('quotatrace-summary.json', JSON.stringify(sum, null, 2));
  // console digest
  if (c && c.calls.length) {
    const tot = c.calls.reduce((s, x) => s + x.total, 0);
    console.log(`Codex: ${c.sessions.size} sessions, ${c.calls.length} calls, ${mt(tot)} tokens, ${q.windows.length} quota windows, ${q.spikes.length} out-of-line quota jumps.`);
  } else if (c) console.log('Codex: no calls in period.');
  if (cl && cl.calls.length) console.log(`Claude Code: ${cl.sessions.size} transcripts, ${cl.calls.length} calls, ${mt(cl.calls.reduce((s, x) => s + x.total, 0))} tokens.`);
  else if (cl) console.log('Claude Code: no calls in period.');
  console.log(`Report written to ${out}`);
  if (args.share) {
    const bodyTxt = 'Anonymous QuotaTrace numbers (per window: day, window minutes, plan, quota points used, k tokens, k uncached input, k output).\n\nPlan/price I pay: \nAnything unusual: \n\n```json\n' + JSON.stringify(sum) + '\n```\n';
    const url = 'https://github.com/lowkey-studio/quotatrace/issues/new?labels=data&title=' + encodeURIComponent('Quota data: ' + (sum.models[0] || 'codex')) + '&body=' + encodeURIComponent(bodyTxt);
    console.log('\nOpen this link to review and post your anonymous numbers to the public dataset:\n' + url.slice(0, 7800));
  }
})();
