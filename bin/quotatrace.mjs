#!/usr/bin/env node
// QuotaTrace: explain where your Codex / Claude Code quota went.
// Reads local session logs only. Never uploads anything. Prints token counts, never prompt or file content.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

import { VERSION, configure, analyseCodex, quotaAnalysis, analyseClaude, shareSummary, buildReport } from './core.mjs';
const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (args.version) { console.log(VERSION); process.exit(0); }

const sinceMs = parseSince(args.since || '7d');
const untilMs = args.until ? Date.parse(args.until) : Infinity;
const TOP = Number(args.top || 10);
const codexHome = args['codex-home'] || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const claudeHome = args['claude-home'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
if (process.argv[2] === 'meter') { meterCmd(process.argv[3]); process.exit(0); }
if (process.argv[2] === 'live') { const { live } = await import('./live.mjs'); await live({ codexHome, claudeHome, intervalSec: Number(args.interval || 5), windowMin: Number(args.window || 10), once: !!args.once }); }

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

Live burn-rate view (tokens per minute and cache hit per session, quota points per hour, time to empty):
  npx github:lowkey-studio/quotatrace live [--window 10] [--interval 5]

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
    if (['help', 'version', 'json', 'share', 'once'].includes(key)) o[key] = true;
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

const mt = n => (n / 1e6).toFixed(2) + 'M';

function fileObjs(paths) {
  const out = [];
  for (const p of paths) {
    let mtimeMs; try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
    out.push({ path: p, mtimeMs, lines: () => readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity }) });
  }
  return out;
}

if (process.argv[2] !== 'live') (async () => {
  let meterText = '';
  try { meterText = fs.readFileSync(args['meter-file'] || path.join(os.homedir(), '.quotatrace', 'claude-limits.jsonl'), 'utf8'); } catch {}
  configure({ sinceMs, untilMs, top: TOP, meterText,
    codexLabel: path.join('~', path.relative(os.homedir(), codexHome)), claudeLabel: path.join('~', path.relative(os.homedir(), claudeHome)) });
  const doCodex = args.only !== 'claude', doClaude = args.only !== 'codex';
  const c = doCodex ? await analyseCodex(fileObjs([...walk(path.join(codexHome, 'sessions')), ...walk(path.join(codexHome, 'archived_sessions'))])) : null;
  const q = c ? quotaAnalysis(c) : null;
  const cl = doClaude ? await analyseClaude(fileObjs(walk(path.join(claudeHome, 'projects')))) : null;
  const out = args.out || 'quotatrace-report.md';
  fs.writeFileSync(out, buildReport(c, q, cl));
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
  if (!args.share) console.log('Want a person to read it and draft your support ticket? QuotaTrace Review, $19: https://quotatrace.appin60.com/#review');
  if (args.share) {
    const bodyTxt = 'Anonymous QuotaTrace numbers (per window: day, window minutes, plan, quota points used, k tokens, k uncached input, k output).\n\nPlan/price I pay: \nAnything unusual: \n\n```json\n' + JSON.stringify(sum) + '\n```\n';
    const url = 'https://github.com/lowkey-studio/quotatrace/issues/new?labels=data&title=' + encodeURIComponent('Quota data: ' + (sum.models[0] || 'codex')) + '&body=' + encodeURIComponent(bodyTxt);
    console.log('\nOpen this link to review and post your anonymous numbers to the public dataset:\n' + url.slice(0, 7800));
  }
})();
