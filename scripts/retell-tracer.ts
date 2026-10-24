import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.retellai.com';
const AGENT_NAME = 'Reroute tracer (issue 3)';
const WEBHOOK_EVENTS = ['call_started', 'transcript_updated', 'call_ended'];
const HELP = `Retell tracer (preflight is read-only)
  node --env-file-if-exists=.env scripts/retell-tracer.ts
  node --env-file-if-exists=.env scripts/retell-tracer.ts --setup
  node --env-file-if-exists=.env scripts/retell-tracer.ts --call

--setup creates/configures a dedicated tracer Agent and Retell LLM; never buys numbers.
--call places ONE real outbound call. Coordinate consent and readiness first.
Do not combine --setup and --call. See docs/retell-tracer.md.`;

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;
type Output = (line: string) => void;
type Request = (
  operation: string,
  path: string,
  method?: string,
  body?: unknown,
) => Promise<unknown>;

class TracerError extends Error {}

function fail(message: string): never {
  throw new TracerError(message);
}

function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('Retell returned an unexpected response shape; raw response withheld.');
  }
  return value as JsonObject;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) fail(`Set ${name} privately in .env.`);
  return value;
}

function identifier(value: unknown, prefix: 'agent' | 'llm' | 'call'): string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,100}$`).test(value)) {
    fail('Retell resource identifier is missing or invalid; value withheld.');
  }
  return value;
}

function publicBase(env: Env): string {
  let url: URL;
  try {
    url = new URL(required(env, 'PUBLIC_BASE_URL'));
  } catch {
    fail('Set PUBLIC_BASE_URL to the HTTPS origin of the public tunnel.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !url.hostname.includes('.') ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    /^[\d.]+$/.test(url.hostname)
  ) {
    fail(
      'PUBLIC_BASE_URL must be a public HTTPS origin without credentials, path, query, or fragment.',
    );
  }
  return url.origin;
}

function phone(env: Env, name: string): string {
  const value = required(env, name);
  if (!/^\+1[2-9]\d{9}$/.test(value)) fail(`${name} must be a US E.164 number; value withheld.`);
  return value;
}

function client(key: string, fetcher: typeof fetch): Request {
  return async (operation, path, method = 'GET', body) => {
    let response: Response;
    try {
      response = await fetcher(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      fail(
        `${operation}: network failure or 10 s timeout; details withheld. No automatic retry. Check Retell before retrying a mutation or call.`,
      );
    }
    if (!response.ok) {
      // Retell errors can echo the entire request, including credentials and phones.
      fail(
        `${operation}: Retell HTTP ${String(response.status)}; response body withheld. Check KYC, workspace billing, permissions, and configuration privately.`,
      );
    }
    try {
      return await response.json();
    } catch {
      fail(
        `${operation}: invalid JSON response; body withheld. Check Retell before retrying a mutation or call.`,
      );
    }
  };
}

async function list(request: Request, kind: 'agents' | 'phone-numbers'): Promise<JsonObject[]> {
  const items: JsonObject[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('pagination_key', cursor);
    const data = object(
      await request(
        `List ${kind}`,
        `/v2/list-${kind}?${query.toString()}`,
        kind === 'agents' ? 'POST' : 'GET',
        kind === 'agents' ? {} : undefined,
      ),
    );
    if (!Array.isArray(data['items']) || typeof data['has_more'] !== 'boolean') {
      fail('Retell list response is invalid; raw response withheld.');
    }
    items.push(...data['items'].map(object));
    if (!data['has_more']) {
      // The live API rejects the documented channel filter. List first and filter locally.
      return kind === 'agents'
        ? items.filter((item) => item['channel'] === undefined || item['channel'] === 'voice')
        : items;
    }
    const next = data['pagination_key'];
    if (typeof next !== 'string' || !next || seen.has(next)) {
      fail('Retell pagination did not advance; cursor withheld.');
    }
    seen.add(next);
    cursor = next;
  }
  fail('Retell inventory exceeds the 20-page tracer limit; narrow the workspace inventory.');
}

function llmConfig(base: string): JsonObject {
  return {
    begin_message:
      'Hi, this is Reroute, an AI voice test arranged with your teammate. May I run the short tracer test?',
    general_prompt: `You are Reroute, running a short test with a consenting teammate.
If an automated call-screening assistant asks your name or reason for calling, say "Reroute, an AI assistant calling for the phone test requested by your teammate." Then wait for the person to join. Screening is not consent or a refusal, and does not use up the clarification attempt.
Wait for a clear yes to the tracer test. Then invoke tracer_ping exactly once with message "reroute tracer confirmed".
After the tool result, briefly say whether the backend acknowledged it, thank the teammate, and end_call.
If the tool fails, report that the tracer was not confirmed and end_call; do not retry the tool.
On no, unclear speech after one clarification, silence, voicemail, or a request to stop, end_call without tracer_ping.
Do not make an Offer or change a Job, Driver, or Placement. Never claim backend success without the tool result.`,
    general_tools: [
      {
        type: 'custom',
        name: 'tracer_ping',
        description:
          'After the teammate clearly agrees, log the tracer once and return the backend acknowledgement.',
        url: `${base}/tools/tracer_ping`,
        method: 'POST',
        args_at_root: false,
        parameters: {
          type: 'object',
          properties: { message: { type: 'string', const: 'reroute tracer confirmed' } },
          required: ['message'],
          additionalProperties: false,
        },
        timeout_ms: 5000,
        max_retry: 0,
        speak_during_execution: false,
        speak_after_execution: true,
      },
      { type: 'end_call', name: 'end_call', description: 'End the tracer test call.' },
    ],
  };
}

function agentConfig(base: string, llmId: string): JsonObject {
  return {
    agent_name: AGENT_NAME,
    response_engine: { type: 'retell-llm', llm_id: llmId },
    voice_id: 'retell-Cimo',
    language: 'en-US',
    webhook_url: `${base}/webhooks/retell`,
    webhook_events: WEBHOOK_EVENTS,
    webhook_timeout_ms: 10_000,
    max_call_duration_ms: 60_000,
    end_call_after_silence_ms: 30_000,
    // Automatic voicemail detection can cut off a call-screening assistant before a person joins.
    // The prompt still ends on actual voicemail and requires explicit human acceptance for the tool.
    voicemail_option: null,
    call_screening_option: {
      agent_identity: 'Reroute, an AI assistant',
      call_purpose: 'the phone test requested by your teammate',
    },
  };
}

async function tracerAgent(request: Request, id: string): Promise<JsonObject> {
  const agent = object(await request('Get tracer Agent', `/get-agent/${id}`));
  if (agent['agent_name'] !== AGENT_NAME) {
    fail('Selected Agent is not the dedicated Reroute tracer; refusing to configure or call it.');
  }
  return agent;
}

export async function runTracer(
  args: string[],
  env: Env,
  fetcher: typeof fetch = fetch,
  output: Output = console.log,
): Promise<void> {
  const flags = args.filter((arg) => arg !== '--');
  if (
    flags.some((arg) => !['--help', '--setup', '--call'].includes(arg)) ||
    new Set(flags).size !== flags.length
  ) {
    fail('Unknown or duplicate flag; use --help. Argument values withheld.');
  }
  if (flags.includes('--setup') && flags.includes('--call'))
    fail('Run --setup and --call separately.');
  if (flags.includes('--help')) {
    output(HELP);
    return;
  }
  const request = client(required(env, 'RETELL_API_KEY'), fetcher);
  const setup = flags.includes('--setup');
  const call = flags.includes('--call');
  const base = setup || call ? publicBase(env) : undefined;
  const selectedId = env['RETELL_TRACER_AGENT_ID']?.trim()
    ? identifier(env['RETELL_TRACER_AGENT_ID'].trim(), 'agent')
    : undefined;
  // Validate local call inputs before any network request.
  const from = call ? phone(env, 'RETELL_FROM_NUMBER') : undefined;
  const to = call ? phone(env, 'RETELL_TO_NUMBER') : undefined;
  if (call && !selectedId) fail('Set RETELL_TRACER_AGENT_ID from --setup before --call.');
  if (call && from === to) fail('Tracer destination must differ from the Retell source number.');

  const concurrency = object(await request('Account preflight', '/get-concurrency'));
  const agents = await list(request, 'agents');
  const numbers = await list(request, 'phone-numbers');
  output(
    'Account API access verified. KYC, card, credit balance, and consent still require human confirmation.',
  );
  const available = concurrency['base_concurrency'];
  if (typeof available === 'number' && Number.isSafeInteger(available) && available >= 0) {
    output(`Base concurrency: ${String(available)}.`);
  }
  output(`Voice Agents: ${String(agents.length)} (names and IDs withheld in inventory).`);
  agents.forEach((agent, index) => {
    output(
      `Agent ${String(index + 1)}: tracer=${String(agent['agent_name'] === AGENT_NAME)}, selected=${String(agent['agent_id'] === selectedId)}, suspended=${String(agent['is_suspended'] === true)}.`,
    );
  });
  output(`Available phone numbers: ${String(numbers.length)} (all digits withheld).`);
  numbers.forEach((number, index) => {
    output(
      `Number ${String(index + 1)}: Retell-managed=${String(['retell-twilio', 'retell-telnyx'].includes(String(number['phone_number_type'])))}, configured source=${String(number['phone_number'] === env['RETELL_FROM_NUMBER']?.trim())}.`,
    );
  });

  if (setup && base) {
    if (selectedId) await tracerAgent(request, selectedId);
    else if (agents.some((agent) => agent['agent_name'] === AGENT_NAME)) {
      fail(
        'A dedicated tracer already exists. Set RETELL_TRACER_AGENT_ID privately from the Retell dashboard, then rerun --setup.',
      );
    }
    // A fresh LLM avoids changing a response engine that another Agent may share.
    const llm = object(
      await request('Create tracer Retell LLM', '/create-retell-llm', 'POST', llmConfig(base)),
    );
    const llmId = identifier(llm['llm_id'], 'llm');
    output(
      `Created tracer Retell LLM ${llmId}. If setup fails, inspect this resource privately before retrying.`,
    );
    const agent = object(
      await request(
        'Configure tracer Agent',
        selectedId ? `/update-agent/${selectedId}` : '/create-agent',
        selectedId ? 'PATCH' : 'POST',
        agentConfig(base, llmId),
      ),
    );
    const agentId = identifier(agent['agent_id'], 'agent');
    output(
      `Tracer configured. Set RETELL_TRACER_AGENT_ID=${agentId} privately in .env. No call placed.`,
    );
  }
  if (call && base && selectedId && from && to) {
    if (!numbers.some((number) => number['phone_number'] === from)) {
      fail('RETELL_FROM_NUMBER is absent from this workspace inventory; no call placed.');
    }
    const agent = await tracerAgent(request, selectedId);
    const version = agent['version'];
    const engine = object(agent['response_engine']);
    const webhookEvents = agent['webhook_events'];
    if (
      agent['webhook_url'] !== `${base}/webhooks/retell` ||
      !Array.isArray(webhookEvents) ||
      !WEBHOOK_EVENTS.every((event) => webhookEvents.includes(event)) ||
      agent['max_call_duration_ms'] !== 60_000 ||
      agent['is_suspended'] === true ||
      engine['type'] !== 'retell-llm' ||
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 0
    )
      fail('Tracer Agent configuration is stale or invalid; rerun --setup before --call.');
    const llmId = identifier(engine['llm_id'], 'llm');
    const llm = object(await request('Get tracer Retell LLM', `/get-retell-llm/${llmId}`));
    const tools = llm['general_tools'];
    if (
      !Array.isArray(tools) ||
      !tools.some((value: unknown) => {
        const tool = object(value);
        return (
          tool['name'] === 'tracer_ping' &&
          tool['type'] === 'custom' &&
          tool['url'] === `${base}/tools/tracer_ping` &&
          tool['method'] === 'POST' &&
          tool['args_at_root'] === false
        );
      })
    )
      fail('Tracer custom function is stale or invalid; rerun --setup before --call.');
    output(
      'Placing one real outbound tracer call to the privately configured teammate. No automatic retries.',
    );
    const result = object(
      await request('Create tracer phone call', '/v2/create-phone-call', 'POST', {
        from_number: from,
        to_number: to,
        override_agent_id: selectedId,
        override_agent_version: version,
        retell_llm_dynamic_variables: {
          call_kind: 'tracer',
          job_id: 'tracer-job',
          driver_id: 'tracer-driver',
          offer_id: 'tracer-offer',
        },
        metadata: { purpose: 'reroute-tracer' },
      }),
    );
    output(
      `Call requested: ${identifier(result['call_id'], 'call')}. This does not prove connection, tool execution, or webhook receipt. Export backend captures after the call ends.`,
    );
  }
}

export async function tracerMain(
  args: string[],
  env: Env,
  fetcher: typeof fetch = fetch,
  output: Output = console.log,
): Promise<number> {
  try {
    await runTracer(args, env, fetcher, output);
    return 0;
  } catch (error) {
    output(
      error instanceof TracerError
        ? error.message
        : 'Tracer failed; unexpected error details withheld. Inspect configuration privately.',
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await tracerMain(process.argv.slice(2), process.env);
}
