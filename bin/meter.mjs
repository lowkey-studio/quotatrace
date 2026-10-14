#!/usr/bin/env node
// QuotaTrace meter: a Claude Code status line command that records rate_limits snapshots.
// Claude Code pipes a JSON object to the status line command on every refresh. This script appends
// {ts, session hash, rate_limits} to ~/.quotatrace/claude-limits.jsonl when the numbers change,
// then prints either the output of your previous status line command or a short default line.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import crypto from 'node:crypto'; import { execSync } from 'node:child_process';
const dir = path.join(os.homedir(), '.quotatrace');
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let d = {}; try { d = JSON.parse(raw); } catch {}
  const rl = d.rate_limits;
  try {
    if (rl && typeof rl === 'object') {
      fs.mkdirSync(dir, { recursive: true });
      const win = {};
      for (const [k, v] of Object.entries(rl)) if (v && v.used_percentage != null) win[k] = [v.used_percentage, v.resets_at ?? null];
      const sig = JSON.stringify(win), last = path.join(dir, '.last');
      let prev = ''; try { prev = fs.readFileSync(last, 'utf8'); } catch {}
      if (sig !== prev && Object.keys(win).length) {
        const s = d.session_id ? crypto.createHash('sha256').update(String(d.session_id)).digest('hex').slice(0, 8) : null;
        fs.appendFileSync(path.join(dir, 'claude-limits.jsonl'), JSON.stringify({ ts: new Date().toISOString(), s, w: win }) + '\n');
        fs.writeFileSync(last, sig);
      }
    }
  } catch {}
  let wrapped = ''; try { wrapped = fs.readFileSync(path.join(dir, 'wrapped-statusline'), 'utf8').trim(); } catch {}
  if (wrapped) {
    try { process.stdout.write(execSync(wrapped, { input: raw, encoding: 'utf8', timeout: 5000, shell: true })); } catch {}
    return;
  }
  const parts = [];
  if (d.model && d.model.display_name) parts.push(d.model.display_name);
  if (rl && rl.five_hour && rl.five_hour.used_percentage != null) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl && rl.seven_day && rl.seven_day.used_percentage != null) parts.push(`week ${Math.round(rl.seven_day.used_percentage)}%`);
  process.stdout.write(parts.join(' · ') || 'quotatrace meter');
});
