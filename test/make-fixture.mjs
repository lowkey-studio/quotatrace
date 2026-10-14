// Writes synthetic Codex rollout logs to test/fixture/.codex so the CLI can be tried and tested without real data.
import fs from 'node:fs'; import path from 'node:path';
const root = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixture', '.codex', 'sessions', '2026', '10', '10');
fs.mkdirSync(root, { recursive: true });
let used = 12, total = 0, t0 = Date.parse('2026-10-10T09:00:00Z');
const resets = Math.floor(t0 / 1000) + 5 * 86400;
function session(name, calls, opts = {}) {
  const L = []; let ctx = 18000, tot = 0, ts = t0 + (opts.offset || 0);
  const push = o => L.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), ...o }));
  push({ type: 'session_meta', payload: { originator: 'codex_cli_rs', cli_version: '0.162.1' } });
  push({ type: 'turn_context', payload: { model: opts.model || 'gpt-6.1-sol', effort: opts.effort || 'high' } });
  for (let i = 0; i < calls; i++) {
    ts += 40000;
    const poll = opts.poll && i % 3 === 2;
    push({ type: 'response_item', payload: { type: 'function_call', name: poll ? 'sleep' : 'exec', arguments: poll ? '{"seconds":30}' : '{"cmd":"npm test"}' } });
    const outChars = opts.bigOutputAt === i ? 240000 : 1800;
    push({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(outChars) } });
    ctx += Math.round(outChars / 4) + 300;
    const cached = Math.round(ctx * 0.93), out = poll ? 40 : 600;
    tot += ctx + out;
    used += (opts.spikeAt === i ? 9 : (ctx + out) / 1e6 * 0.4);
    push({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: tot }, last_token_usage: { input_tokens: ctx, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: Math.round(out / 3), total_tokens: ctx + out } }, rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: Math.floor(used), window_minutes: 10080, resets_at: resets } } } });
  }
  fs.writeFileSync(path.join(root, `rollout-2026-10-10T09-00-00-${name}.jsonl`), L.join('\n') + '\n');
}
session('a', 120, { bigOutputAt: 10, poll: true });
session('b', 60, { offset: 6 * 3600e3, spikeAt: 30, model: 'gpt-6-astra', effort: 'xhigh' });
console.log('fixture written to', path.dirname(path.dirname(path.dirname(path.dirname(root)))));
