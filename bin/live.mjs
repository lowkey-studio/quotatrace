// QuotaTrace live: a burn-rate "speedometer" for running Codex / Claude Code sessions.
// Tails session logs modified recently and prints, per session, tokens per minute and the latest
// prompt-cache hit rate, plus quota points per hour and the projected time until each window is empty.
// Local only: reads log files, makes no network requests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function live({ codexHome, claudeHome, intervalSec = 5, windowMin = 10, once = false }) {
  const offsets = new Map();   // file -> bytes read
  const partial = new Map();   // file -> trailing partial line
  const sessions = new Map();  // file -> { tool, model, calls: [{ts,total,input,cached}], lastHit }
  const quota = new Map();     // window key -> [{ts, used, resets, name}]
  const meterFile = path.join(os.homedir(), '.quotatrace', 'claude-limits.jsonl');
  const seen = new Set();
  let lastSnapTs = 0;

  const recentFiles = (dir, maxAgeMs) => {
    const out = [];
    const walk = d => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { continue; } }
        if (isDir) walk(p);
        else if (e.name.endsWith('.jsonl')) { try { if (Date.now() - fs.statSync(p).mtimeMs < maxAgeMs) out.push(p); } catch {} }
      }
    };
    walk(dir);
    return out;
  };

  const readNew = file => {
    let size; try { size = fs.statSync(file).size; } catch { return []; }
    let off = offsets.get(file);
    if (off == null) off = Math.max(0, size - 4 * 1024 * 1024); // start near the end of big files
    if (size < off) off = 0;
    if (size === off) return [];
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    fs.closeSync(fd);
    offsets.set(file, size);
    const text = (partial.get(file) || '') + buf.toString('utf8');
    const lines = text.split('\n');
    partial.set(file, lines.pop());
    return lines;
  };

  const addQuota = (name, used, resets, ts) => {
    const key = name + '|' + Math.round((Number(resets) || 0) / 900);
    const arr = quota.get(key) || [];
    arr.push({ ts, used, resets: Number(resets) || null, name });
    quota.set(key, arr.filter(x => x.ts > Date.now() - 6 * 3600e3));
  };

  const tick = () => {
    const horizon = Math.max(windowMin, 30) * 60e3;
    for (const f of recentFiles(path.join(codexHome, 'sessions'), horizon)) {
      const s = sessions.get(f) || { tool: 'codex', model: '?', calls: [], lastHit: null, lastTotal: null };
      for (const line of readNew(f)) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        const p = d.payload || {};
        const ts = Date.parse(d.timestamp || '') || Date.now();
        if (d.type === 'turn_context' && p.model) s.model = p.model + (p.effort ? '/' + p.effort : '');
        if (d.type === 'event_msg' && p.type === 'token_count') {
          const info = p.info;
          if (info && info.total_token_usage && info.total_token_usage.total_tokens !== s.lastTotal) {
            s.lastTotal = info.total_token_usage.total_tokens;
            const u = info.last_token_usage || {};
            s.calls.push({ ts, total: u.total_tokens || 0, input: u.input_tokens || 0, cached: u.cached_input_tokens || 0 });
            if (u.input_tokens) s.lastHit = (u.cached_input_tokens || 0) / u.input_tokens;
          }
          const rl = p.rate_limits;
          if (rl) for (const w of ['primary', 'secondary']) {
            const x = rl[w];
            if (x && x.used_percent != null) addQuota(`codex ${x.window_minutes === 300 ? '5h' : x.window_minutes === 10080 ? 'week' : x.window_minutes + 'm'}`, x.used_percent, x.resets_at ?? (x.resets_in_seconds != null ? ts / 1000 + x.resets_in_seconds : 0), ts);
          }
        }
      }
      sessions.set(f, s);
    }
    for (const f of recentFiles(path.join(claudeHome, 'projects'), horizon)) {
      const s = sessions.get(f) || { tool: 'claude', model: '?', calls: [], lastHit: null };
      for (const line of readNew(f)) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        const m = d.message;
        if (d.type !== 'assistant' || !m || !m.usage) continue;
        const key = (m.id || '') + ':' + (d.requestId || '');
        if (m.id && seen.has(key)) continue;
        seen.add(key);
        const u = m.usage, ts = Date.parse(d.timestamp || '') || Date.now();
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        s.model = m.model || s.model;
        s.calls.push({ ts, total: ctx + (u.output_tokens || 0), input: ctx, cached: u.cache_read_input_tokens || 0 });
        if (ctx) s.lastHit = (u.cache_read_input_tokens || 0) / ctx;
      }
      sessions.set(f, s);
    }
    const snap = readClaudeJsonUtilization();
    if (snap && snap.ts !== lastSnapTs) { lastSnapTs = snap.ts; for (const [name, [used, resets]] of Object.entries(snap.w)) addQuota('claude ' + name.replace('five_hour', '5h').replace('seven_day', 'week'), used, resets, snap.ts); }
    for (const line of (fs.existsSync(meterFile) ? readNew(meterFile) : [])) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(d.ts) || Date.now();
      for (const [name, [used, resets]] of Object.entries(d.w || {})) addQuota('claude ' + name.replace('five_hour', '5h').replace('seven_day', 'week'), used, typeof resets === 'string' && isNaN(Number(resets)) ? Date.parse(resets) / 1000 : resets, ts);
    }
    render();
  };

  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
  const pad = (s, n) => String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length);
  const render = () => {
    const now = Date.now(), from = now - windowMin * 60e3;
    const L = [];
    L.push(`QuotaTrace live · ${new Date().toISOString().slice(11, 19)} UTC · last ${windowMin} min · Ctrl+C to stop`);
    L.push('');
    L.push(pad('QUOTA WINDOW', 16) + pad('USED', 7) + pad('PTS/HOUR', 10) + 'EMPTY IN');
    let anyQ = false;
    for (const arr of quota.values()) {
      const last = arr[arr.length - 1];
      if (now - last.ts > 6 * 3600e3) continue;
      anyQ = true;
      const base = arr.find(x => x.ts >= now - 30 * 60e3) || arr[0];
      const hrs = (last.ts - base.ts) / 3600e3;
      const rate = hrs > 0.05 ? (last.used - base.used) / hrs : null;
      let eta = '-';
      if (rate && rate > 0) {
        const h = (100 - last.used) / rate;
        const resetIn = last.resets ? (last.resets * 1000 - now) / 3600e3 : Infinity;
        eta = h > resetIn ? `resets first (${resetIn.toFixed(1)}h)` : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
      }
      L.push(pad(last.name, 16) + pad(last.used + '%', 7) + pad(rate == null ? '-' : rate.toFixed(1), 10) + eta);
    }
    if (!anyQ) L.push('(no quota readings yet: Codex logs them with each call; for Claude Code run `quotatrace meter install`)');
    L.push('');
    L.push(pad('SESSION', 10) + pad('TOOL', 8) + pad('MODEL', 22) + pad('TOK/MIN', 9) + pad('CALLS', 7) + pad('CONTEXT', 9) + 'CACHE HIT');
    const rows = [];
    for (const [f, s] of sessions) {
      const recent = s.calls.filter(c => c.ts >= from);
      if (!recent.length) continue;
      const tok = recent.reduce((a, c) => a + c.total, 0);
      const mins = Math.max(1, (now - Math.max(from, recent[0].ts)) / 60e3);
      rows.push({ id: path.basename(f).replace(/^rollout-[\dT:-]+-?/, '').replace('.jsonl', '').slice(-8), s, rate: tok / mins, n: recent.length, ctx: recent[recent.length - 1].input });
    }
    rows.sort((a, b) => b.rate - a.rate);
    const total = rows.reduce((a, r) => a + r.rate, 0);
    for (const r of rows.slice(0, 15)) L.push(pad(r.id, 10) + pad(r.s.tool, 8) + pad(r.s.model, 22) + pad(fmtTok(r.rate), 9) + pad(r.n, 7) + pad(fmtTok(r.ctx), 9) + (r.s.lastHit == null ? '-' : Math.round(r.s.lastHit * 100) + '%'));
    if (!rows.length) L.push(`(no model calls in the last ${windowMin} min)`);
    else L.push(pad('', 10) + pad('', 8) + pad('all sessions', 22) + fmtTok(total));
    const out = L.join('\n');
    if (once || !process.stdout.isTTY) console.log(out + '\n');
    else process.stdout.write('\x1b[H\x1b[2J' + out + '\n');
  };

  tick();
  if (once) return;
  setInterval(tick, intervalSec * 1000);
}

// Claude Code caches the plan's current utilization in ~/.claude.json (cachedUsageUtilization), refreshed now and then.
export function readClaudeJsonUtilization(file = path.join(os.homedir(), '.claude.json')) {
  let d; try { d = JSON.parse(fs.readFileSync(file, 'utf8')).cachedUsageUtilization; } catch { return null; }
  if (!d || !d.utilization || !d.fetchedAtMs) return null;
  const w = {};
  for (const [k, v] of Object.entries(d.utilization)) {
    if (v && typeof v === 'object' && typeof v.utilization === 'number' && /^(five_hour|seven_day)/.test(k)) w[k] = [v.utilization, v.resets_at ? Date.parse(v.resets_at) / 1000 : null];
  }
  return Object.keys(w).length ? { ts: d.fetchedAtMs, w } : null;
}

// Background recorder: appends each new ~/.claude.json utilization snapshot to the meter file. No settings changes.
export async function record({ intervalSec = 60 }) {
  const dir = path.join(os.homedir(), '.quotatrace'), out = path.join(dir, 'claude-limits.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  let last = 0;
  console.log(`Recording Claude Code utilization snapshots from ~/.claude.json to ${out} every ${intervalSec}s. Leave it running; Ctrl+C to stop.`);
  const tick = () => {
    const s = readClaudeJsonUtilization();
    if (s && s.ts !== last) { last = s.ts; fs.appendFileSync(out, JSON.stringify({ ts: new Date(s.ts).toISOString(), s: 'claude.json', w: s.w }) + '\n'); }
  };
  tick(); setInterval(tick, intervalSec * 1000);
}
