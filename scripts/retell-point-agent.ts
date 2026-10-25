/**
 * Point the fleet Retell agent(s) at the current public URL: every custom tool's URL becomes
 * `${PUBLIC_BASE_URL}/tools/<name>` and the agent webhook becomes `${PUBLIC_BASE_URL}/webhooks/retell`.
 *
 *   node --env-file-if-exists=.env scripts/retell-point-agent.ts           # dry run: show the diff
 *   node --env-file-if-exists=.env scripts/retell-point-agent.ts --apply   # write, then read back
 *
 * Refuses to apply unless `${PUBLIC_BASE_URL}/health` answers 200, so a dead tunnel is never
 * written into the agent. Covers RETELL_AGENT_ID and any per-kind RETELL_AGENT_* overrides.
 * The tracer agent (RETELL_TRACER_AGENT_ID) is deliberately left alone.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });

const env = (name: string) => process.env[name]?.trim() ?? '';
const key = env('RETELL_API_KEY');
const base = env('PUBLIC_BASE_URL').replace(/\/+$/, '');
if (!key || !base) {
  console.error('Set RETELL_API_KEY and PUBLIC_BASE_URL in .env.');
  process.exit(2);
}
if (!base.startsWith('https://')) {
  console.error(`PUBLIC_BASE_URL must be https:// (got ${base}).`);
  process.exit(2);
}

type Rec = Record<string, unknown>;

async function retell(method: string, path: string, body?: unknown): Promise<Rec> {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${path} → HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Rec;
}

// 1. The tunnel must actually reach this server.
try {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8_000) });
  if (!health.ok) throw new Error(`HTTP ${String(health.status)}`);
  console.log(`✅ ${base}/health → ${String(health.status)}`);
} catch (error) {
  console.error(
    `❌ ${base}/health unreachable (${String(error)}). Start the server and tunnel first.`,
  );
  process.exit(1);
}

const agentIds = [
  ...new Set(
    [
      'RETELL_AGENT_ID',
      'RETELL_AGENT_OFFER',
      'RETELL_AGENT_AT_RISK_CHECK',
      'RETELL_AGENT_RELEASE',
      'RETELL_AGENT_ESCALATION',
    ]
      .map(env)
      .filter(Boolean),
  ),
];
const tracer = env('RETELL_TRACER_AGENT_ID');
if (agentIds.length === 0) {
  console.error('Set RETELL_AGENT_ID in .env.');
  process.exit(2);
}

const host = (url: unknown) => (typeof url === 'string' ? (url.split('/')[2] ?? url) : '-');
let changes = 0;

for (const agentId of agentIds) {
  if (agentId === tracer) {
    console.log(`⏭  ${agentId} is the tracer agent; skipping.`);
    continue;
  }
  const agent = await retell('GET', `/get-agent/${agentId}`);
  const engine = (agent['response_engine'] ?? {}) as Rec;
  const llmId = typeof engine['llm_id'] === 'string' ? engine['llm_id'] : '';
  console.log(
    `\nagent ${agentId} · version ${String(agent['version'])} · published ${String(agent['is_published'])}`,
  );

  const webhook = `${base}/webhooks/retell`;
  if (agent['webhook_url'] !== webhook) {
    changes += 1;
    console.log(`  webhook_url: ${host(agent['webhook_url'])} → ${host(webhook)}`);
    if (values.apply) await retell('PATCH', `/update-agent/${agentId}`, { webhook_url: webhook });
  } else {
    console.log('  webhook_url: already current');
  }

  if (engine['type'] !== 'retell-llm' || !llmId) {
    console.log(`  response engine ${String(engine['type'])}: no Retell LLM tools to update`);
    continue;
  }
  const llm = await retell('GET', `/get-retell-llm/${llmId}`);
  const tools = (Array.isArray(llm['general_tools']) ? llm['general_tools'] : []) as Rec[];
  // Send the complete list so nothing is dropped, whatever Retell's PATCH semantics.
  const updated = tools.map((tool) => {
    if (tool['type'] !== 'custom' || typeof tool['name'] !== 'string') return tool;
    const url = `${base}/tools/${tool['name']}`;
    if (tool['url'] !== url) {
      changes += 1;
      console.log(`  tool ${tool['name']}: ${host(tool['url'])} → ${host(url)}`);
    }
    return { ...tool, url };
  });
  if (values.apply) {
    await retell('PATCH', `/update-retell-llm/${llmId}`, { general_tools: updated });
    const check = await retell('GET', `/get-retell-llm/${llmId}`);
    const after = (Array.isArray(check['general_tools']) ? check['general_tools'] : []) as Rec[];
    const stale = after.filter(
      (t) => t['type'] === 'custom' && t['url'] !== `${base}/tools/${String(t['name'])}`,
    );
    if (after.length !== tools.length || stale.length > 0) {
      console.error(
        `  ❌ read-back mismatch: ${String(after.length)}/${String(tools.length)} tools, ${String(stale.length)} stale`,
      );
      process.exit(1);
    }
    console.log(`  ✅ read back ${String(after.length)} tools, all on ${host(base)}`);
  }
}

// 2. Which agent version does the phone number actually use?
const from = env('RETELL_FROM_NUMBER');
if (from) {
  try {
    const number = await retell('GET', `/get-phone-number/${encodeURIComponent(from)}`);
    console.log(
      `\nnumber …${from.slice(-2)}: outbound agent ${String(number['outbound_agent_id'])} ` +
        `(version ${JSON.stringify(number['outbound_agent_version'] ?? 'latest')}), inbound agent ` +
        `${String(number['inbound_agent_id'])} (version ${JSON.stringify(number['inbound_agent_version'] ?? 'latest')})`,
    );
  } catch (error) {
    console.log(`\n(could not read phone number binding: ${String(error).slice(0, 120)})`);
  }
}

console.log(
  values.apply
    ? `\nApplied ${String(changes)} change(s).`
    : `\nDry run: ${String(changes)} change(s) pending. Re-run with --apply to write them.`,
);
