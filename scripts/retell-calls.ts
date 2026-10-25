/**
 * Debug aid: print the most recent Retell calls with every tool invocation and the exact
 * result our backend returned, so a failing live call can be diagnosed without a phone.
 *
 *   node --env-file-if-exists=.env scripts/retell-calls.ts [--limit 3] [--call <call_id>]
 *
 * Phone numbers are masked. Exits 1 when any tool result looks like a backend rejection.
 */
import { parseArgs } from 'node:util';

const REJECTIONS = [
  'Unable to verify this call',
  'This call belongs to a previous demo',
  "I don't recognise this Driver's call",
  'The Job does not match this call',
  'This Offer does not belong to this call',
  'Invalid call payload',
  'Invalid call context',
  'Call tool does not match',
  'not confirmed',
];

const { values } = parseArgs({
  options: { limit: { type: 'string', default: '3' }, call: { type: 'string' } },
});

const key = process.env['RETELL_API_KEY'];
if (!key) {
  console.error('RETELL_API_KEY is not set (put it in .env).');
  process.exit(2);
}

const mask = (s: string) => s.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => `…${m.slice(-2)}`);
const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function retell(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${String(res.status)}: ${short(await res.text())}`);
  return res.json();
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

// get-call carries transcript_with_tool_calls; v3 list items omit it.
async function getCall(id: string): Promise<Rec> {
  try {
    return (await retell(`/v2/get-call/${id}`)) as Rec;
  } catch {
    return (await retell(`/v1/get-call/${id}`)) as Rec;
  }
}

const ids: string[] = values.call
  ? [values.call]
  : (
      (await retell('/v3/list-calls', {
        limit: Number(values.limit),
        sort_order: 'descending',
      })) as { items: Rec[] }
    ).items.map((c) => str(c['call_id']));
const calls: Rec[] = [];
for (const id of ids) calls.push(await getCall(id));

let rejected = 0;
for (const call of calls) {
  const vars = (call['retell_llm_dynamic_variables'] ?? {}) as Rec;
  const latency = (call['latency'] ?? {}) as Rec;
  const e2e = (latency['e2e'] ?? {}) as Rec;
  const llm = (latency['llm'] ?? {}) as Rec;
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(
    `call ${str(call['call_id'])} · ${str(call['direction'])} · ${str(call['call_status'])} · ` +
      `ended: ${str(call['disconnection_reason'])} · agent ${str(call['agent_id'])}`,
  );
  console.log(
    `duration ${String(Number(call['duration_ms'] ?? 0) / 1000)}s · ` +
      `latency e2e p50 ${str(e2e['p50'])}ms · llm p50 ${str(llm['p50'])}ms`,
  );
  console.log(
    'dynamic vars:',
    Object.keys(vars).length === 0
      ? '(none)'
      : Object.entries(vars)
          .map(([k, v]) => `${k}=${mask(str(v))}`)
          .join(' '),
  );
  const turns = (call['transcript_with_tool_calls'] ?? []) as Rec[];
  if (turns.length === 0) console.log('(no transcript_with_tool_calls on this call)');
  for (const t of turns) {
    const role = str(t['role']);
    if (role === 'tool_call_invocation') {
      console.log(`  🔧 ${str(t['name'])}(${mask(short(str(t['arguments'])))})`);
    } else if (role === 'tool_call_result') {
      const content = str(t['content']);
      const bad = REJECTIONS.some((r) => content.includes(r)) || t['successful'] === false;
      if (bad) rejected += 1;
      console.log(`  ${bad ? '❌' : '✅'} result: ${mask(short(content))}`);
    } else {
      console.log(`  ${role.padEnd(5)}: ${mask(short(str(t['content'])))}`);
    }
  }
}

console.log(`\n${rejected === 0 ? 'GREEN' : 'RED'}: ${String(rejected)} rejected tool result(s)`);
process.exit(rejected === 0 ? 0 : 1);
