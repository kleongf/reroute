/**
 * Point the fleet Retell agent(s) at the current public URL: every custom tool's URL becomes
 * `${PUBLIC_BASE_URL}/tools/<name>` and the agent webhook becomes `${PUBLIC_BASE_URL}/webhooks/retell`.
 *
 *   node --env-file-if-exists=.env scripts/retell-point-agent.ts           # dry run: show the diff
 *   node --env-file-if-exists=.env scripts/retell-point-agent.ts --apply   # write, then read back
 *   … --sync-prompt                    # also publish the committed prompt files
 *
 * Refuses to apply unless `${PUBLIC_BASE_URL}/health` answers 200, so a dead tunnel is never
 * written into the agent. Covers RETELL_AGENT_ID and any per-kind RETELL_AGENT_* overrides.
 * The tracer agent (RETELL_TRACER_AGENT_ID) is deliberately left alone.
 */
import { parseArgs } from 'node:util';
import { buildRetellConfig } from './retell-config.ts';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    // Also replace the LLM's general_prompt with the committed src/retell/prompts/*.md.
    'sync-prompt': { type: 'boolean', default: false },
  },
});

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
  // Some endpoints (e.g. publish-agent-version) answer 200 with an empty body.
  return (text.trim() === '' ? {} : JSON.parse(text)) as Rec;
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

const urlFor = (tool: Rec) => `${base}/tools/${String(tool['name'])}`;
const toolsOf = (llm: Rec) =>
  (Array.isArray(llm['general_tools']) ? llm['general_tools'] : []) as Rec[];
const staleTools = (tools: Rec[]) =>
  tools.filter((t) => t['type'] === 'custom' && t['url'] !== urlFor(t));
const webhook = `${base}/webhooks/retell`;

/**
 * Calls use the agent's `latest_published` version (src/retell/voice.ts), and published
 * versions are immutable. So: draft from the published version → point the draft's LLM
 * tools and webhook → publish the draft → read `latest_published` back and verify.
 */
for (const agentId of agentIds) {
  if (agentId === tracer) {
    console.log(`⏭  ${agentId} is the tracer agent; skipping.`);
    continue;
  }
  const published = await retell('GET', `/get-agent/${agentId}?version=latest_published`);
  const engine = (published['response_engine'] ?? {}) as Rec;
  const llmId = typeof engine['llm_id'] === 'string' ? engine['llm_id'] : '';
  console.log(`\nagent ${agentId} · latest published version ${String(published['version'])}`);
  if (engine['type'] !== 'retell-llm' || !llmId) {
    console.log(`  response engine ${String(engine['type'])}: no Retell LLM tools to update`);
    continue;
  }
  const llm = await retell('GET', `/get-retell-llm/${llmId}?version=${String(engine['version'])}`);
  const tools = toolsOf(llm);
  const pending = staleTools(tools);
  const webhookStale = published['webhook_url'] !== webhook;
  for (const t of pending) {
    console.log(`  tool ${String(t['name'])}: ${host(t['url'])} → ${host(urlFor(t))}`);
  }
  if (webhookStale) {
    console.log(`  webhook_url: ${host(published['webhook_url'])} → ${host(webhook)}`);
  }
  const prompt = values['sync-prompt'] ? buildRetellConfig(base).llm.general_prompt : null;
  const promptStale = prompt !== null && llm['general_prompt'] !== prompt;
  if (promptStale) {
    console.log(
      `  general_prompt: ${String(typeof llm['general_prompt'] === 'string' ? llm['general_prompt'].length : 0)} → ${String(prompt.length)} chars`,
    );
  }
  const count = pending.length + (webhookStale ? 1 : 0) + (promptStale ? 1 : 0);
  changes += count;
  if (count === 0) {
    console.log('  already current');
    continue;
  }
  if (!values.apply) continue;

  const draft = await retell('POST', `/create-agent-version/${agentId}`, {
    base_version: published['version'],
  });
  const draftVersion = String(draft['version']);
  const draftEngine = (draft['response_engine'] ?? {}) as Rec;
  const draftLlmVersion = String(draftEngine['version'] ?? engine['version']);
  console.log(`  draft version ${draftVersion} (LLM version ${draftLlmVersion})`);
  // Send the complete tool list so nothing is dropped, whatever Retell's PATCH semantics.
  await retell('PATCH', `/update-retell-llm/${llmId}?version=${draftLlmVersion}`, {
    general_tools: tools.map((t) => (t['type'] === 'custom' ? { ...t, url: urlFor(t) } : t)),
    ...(prompt === null ? {} : { general_prompt: prompt }),
  });
  await retell('PATCH', `/update-agent/${agentId}?version=${draftVersion}`, {
    webhook_url: webhook,
  });
  await retell('POST', `/publish-agent-version/${agentId}`, {
    version: Number(draftVersion),
    version_title: `Point at ${host(base)}${prompt === null ? '' : ' + prompt sync'}`,
  });

  const live = await retell('GET', `/get-agent/${agentId}?version=latest_published`);
  const liveEngine = (live['response_engine'] ?? {}) as Rec;
  const liveTools = toolsOf(
    await retell('GET', `/get-retell-llm/${llmId}?version=${String(liveEngine['version'])}`),
  );
  const stillStale = staleTools(liveTools);
  const liveLlm = await retell(
    'GET',
    `/get-retell-llm/${llmId}?version=${String(liveEngine['version'])}`,
  );
  if (prompt !== null && liveLlm['general_prompt'] !== prompt) {
    console.error(
      '  ❌ read-back mismatch: published general_prompt differs from the prompt files',
    );
    process.exit(1);
  }
  if (
    String(live['version']) !== draftVersion ||
    live['webhook_url'] !== webhook ||
    liveTools.length !== tools.length ||
    stillStale.length > 0
  ) {
    console.error(
      `  ❌ read-back mismatch: published v${String(live['version'])}, ` +
        `${String(liveTools.length)}/${String(tools.length)} tools, ${String(stillStale.length)} stale, ` +
        `webhook ${host(live['webhook_url'])}`,
    );
    process.exit(1);
  }
  console.log(
    `  ✅ published v${draftVersion}: ${String(liveTools.length)} tools + webhook on ${host(base)}`,
  );
}

// 2. Which agent version does the phone number actually use?
const from = env('RETELL_FROM_NUMBER');
if (from) {
  try {
    const number = await retell('GET', `/get-phone-number/${encodeURIComponent(from)}`);
    const list = (key: string) =>
      (Array.isArray(number[key]) ? (number[key] as Rec[]) : [])
        .map((a) => `${String(a['agent_id'])}@${JSON.stringify(a['agent_version'])}`)
        .join(', ') || '-';
    console.log(
      `\nnumber …${from.slice(-2)}: inbound ${list('inbound_agents')}; default outbound ` +
        `${list('outbound_agents')} (outbound calls override this with the fleet agent's latest_published)`,
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
