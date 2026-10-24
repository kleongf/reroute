import { describe, expect, it, vi } from 'vitest';
import { runTracer, tracerMain } from './retell-tracer.ts';

const env = {
  RETELL_API_KEY: 'private-key-test-only',
  PUBLIC_BASE_URL: 'https://tracer.example.test',
  RETELL_FROM_NUMBER: '+14155550100',
  RETELL_TO_NUMBER: '+14155550101',
  RETELL_TRACER_AGENT_ID: 'agent_tracer',
};
const agent = {
  agent_id: 'agent_tracer',
  agent_name: 'Reroute tracer (issue 3)',
  version: 0,
  response_engine: { type: 'retell-llm', llm_id: 'llm_tracer' },
  webhook_url: `${env.PUBLIC_BASE_URL}/webhooks/retell`,
  webhook_events: ['call_started', 'transcript_updated', 'call_ended'],
  max_call_duration_ms: 60_000,
};
const llm = {
  general_tools: [
    {
      name: 'tracer_ping',
      type: 'custom',
      method: 'POST',
      args_at_root: false,
      url: `${env.PUBLIC_BASE_URL}/tools/tracer_ping`,
    },
  ],
};
const inventory = [
  { base_concurrency: 20 },
  { items: [{ ...agent, agent_name: 'Private teammate name' }], has_more: false },
  {
    items: [{ phone_number: env.RETELL_FROM_NUMBER, phone_number_type: 'retell-twilio' }],
    has_more: false,
  },
];

function mockApi(responses: unknown[]) {
  const queue = [...responses];
  const requests: { url: string; init: RequestInit | undefined; body: unknown }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (!queue.length) throw new Error('Unexpected API request');
    const next = queue.shift();
    return Promise.resolve(next instanceof Response ? next : Response.json(next));
  };
  return { fetcher, requests };
}

describe('Retell tracer CLI', () => {
  it('has no side effects on import and needs no env or requests for help', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output = vi.fn<(line: string) => void>();
    expect(await tracerMain(['--help'], {}, fetcher, output)).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('preflight is read-only'));
  });

  it('defaults to read-only account/inventory checks with private summaries', async () => {
    const api = mockApi(inventory);
    const lines: string[] = [];
    await runTracer([], env, api.fetcher, (line) => lines.push(line));
    expect(api.requests.map(({ url, init }) => [new URL(url).pathname, init?.method])).toEqual([
      ['/get-concurrency', 'GET'],
      ['/v2/list-agents', 'POST'],
      ['/v2/list-phone-numbers', 'GET'],
    ]);
    expect(api.requests[1]?.body).toEqual({});
    for (const { init } of api.requests) {
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe('error');
    }
    for (const privateValue of [
      env.RETELL_API_KEY,
      env.RETELL_FROM_NUMBER,
      env.RETELL_TO_NUMBER,
      'Private teammate name',
    ]) {
      expect(lines.join('\n')).not.toContain(privateValue);
    }
  });

  it('follows current paginated inventory responses and withholds cursors', async () => {
    const api = mockApi([
      inventory[0],
      { items: [], has_more: true, pagination_key: 'private-cursor' },
      { items: [], has_more: false },
      inventory[2],
    ]);
    await runTracer([], env, api.fetcher, vi.fn());
    expect(new URL(api.requests[2]?.url ?? '').searchParams.get('pagination_key')).toBe(
      'private-cursor',
    );
  });

  it('filters chat Agents locally because the live API rejects the documented channel filter', async () => {
    const api = mockApi([
      inventory[0],
      {
        items: [
          { ...agent, channel: 'voice' },
          { agent_id: 'agent_chat', channel: 'chat' },
        ],
        has_more: false,
      },
      inventory[2],
    ]);
    const lines: string[] = [];
    await runTracer([], env, api.fetcher, (line) => lines.push(line));
    expect(lines).toContain('Voice Agents: 1 (names and IDs withheld in inventory).');
    expect(lines.join('\n')).not.toContain('agent_chat');
  });

  it('rejects stuck pagination instead of looping', async () => {
    const api = mockApi([inventory[0], { items: [], has_more: true }]);
    await expect(runTracer([], env, api.fetcher, vi.fn())).rejects.toThrow(
      'pagination did not advance',
    );
  });

  it('creates a dedicated LLM, tool envelope, and Agent without buying a number or calling', async () => {
    const api = mockApi([...inventory, { llm_id: 'llm_new' }, { agent_id: 'agent_new' }]);
    await runTracer(['--setup'], { ...env, RETELL_TRACER_AGENT_ID: '' }, api.fetcher, vi.fn());
    expect(
      api.requests.slice(3).map(({ url, init }) => [new URL(url).pathname, init?.method]),
    ).toEqual([
      ['/create-retell-llm', 'POST'],
      ['/create-agent', 'POST'],
    ]);
    expect(api.requests[3]?.body).toMatchObject({
      general_tools: [
        {
          name: 'tracer_ping',
          type: 'custom',
          method: 'POST',
          url: `${env.PUBLIC_BASE_URL}/tools/tracer_ping`,
          args_at_root: false,
          parameters: { required: ['message'], properties: { message: { type: 'string' } } },
          timeout_ms: 5000,
          max_retry: 0,
        },
        { type: 'end_call' },
      ],
    });
    expect(api.requests[4]?.body).toMatchObject({
      agent_name: 'Reroute tracer (issue 3)',
      response_engine: { llm_id: 'llm_new', type: 'retell-llm' },
      webhook_url: `${env.PUBLIC_BASE_URL}/webhooks/retell`,
      webhook_events: agent.webhook_events,
      max_call_duration_ms: 60_000,
      voicemail_option: { action: { type: 'hangup' } },
    });
  });

  it('configures an existing dedicated Agent using a fresh LLM', async () => {
    const api = mockApi([...inventory, agent, { llm_id: 'llm_new' }, agent]);
    await runTracer(['--setup'], env, api.fetcher, vi.fn());
    expect(api.requests[5]?.url).toBe('https://api.retellai.com/update-agent/agent_tracer');
    expect(api.requests[5]?.init?.method).toBe('PATCH');
    expect(api.requests[5]?.body).toMatchObject({ response_engine: { llm_id: 'llm_new' } });
  });

  it('refuses setup against an unrelated Agent before any account mutation', async () => {
    const api = mockApi([...inventory, { ...agent, agent_name: 'Production' }]);
    await expect(runTracer(['--setup'], env, api.fetcher, vi.fn())).rejects.toThrow(
      'not the dedicated',
    );
    expect(api.requests).toHaveLength(4);
  });

  it('refuses to create duplicate tracer Agents', async () => {
    const api = mockApi([inventory[0], { items: [agent], has_more: false }, inventory[2]]);
    await expect(
      runTracer(['--setup'], { ...env, RETELL_TRACER_AGENT_ID: '' }, api.fetcher, vi.fn()),
    ).rejects.toThrow('already exists');
    expect(api.requests).toHaveLength(3);
  });

  it('places exactly one explicit outbound call with pinned Agent version and string context', async () => {
    const api = mockApi([
      ...inventory,
      agent,
      llm,
      { call_id: 'call_tracer', transcript: 'Private speech' },
    ]);
    const lines: string[] = [];
    await runTracer(['--call'], env, api.fetcher, (line) => lines.push(line));
    expect(api.requests[5]?.url).toBe('https://api.retellai.com/v2/create-phone-call');
    expect(api.requests[5]?.body).toEqual({
      from_number: env.RETELL_FROM_NUMBER,
      to_number: env.RETELL_TO_NUMBER,
      override_agent_id: 'agent_tracer',
      override_agent_version: 0,
      retell_llm_dynamic_variables: {
        call_kind: 'tracer',
        job_id: 'tracer-job',
        driver_id: 'tracer-driver',
        offer_id: 'tracer-offer',
      },
      metadata: { purpose: 'reroute-tracer' },
    });
    expect(api.requests).toHaveLength(6);
    expect(lines.join('\n')).toContain('does not prove connection');
    expect(lines.join('\n')).not.toContain('Private speech');
  });

  it('refuses stale custom-function and webhook configuration without dialing', async () => {
    const api = mockApi([
      ...inventory,
      agent,
      { general_tools: [{ ...llm.general_tools[0], args_at_root: true }] },
    ]);
    await expect(runTracer(['--call'], env, api.fetcher, vi.fn())).rejects.toThrow(
      'custom function is stale',
    );
    expect(api.requests).toHaveLength(5);
    const stale = mockApi([...inventory, { ...agent, webhook_events: ['call_ended'] }]);
    await expect(runTracer(['--call'], env, stale.fetcher, vi.fn())).rejects.toThrow(
      'Agent configuration is stale',
    );
    expect(stale.requests).toHaveLength(4);
  });

  it('requires a source number from this workspace', async () => {
    const api = mockApi([inventory[0], inventory[1], { items: [], has_more: false }]);
    await expect(runTracer(['--call'], env, api.fetcher, vi.fn())).rejects.toThrow(
      'absent from this workspace',
    );
    expect(api.requests).toHaveLength(3);
  });

  it.each([
    { args: ['--setup', '--call'], changes: {} },
    { args: ['--call'], changes: { RETELL_TO_NUMBER: 'bad-phone' } },
    { args: ['--call'], changes: { RETELL_TRACER_AGENT_ID: '' } },
    { args: ['--call'], changes: { RETELL_TO_NUMBER: env.RETELL_FROM_NUMBER } },
    { args: ['--setup'], changes: { PUBLIC_BASE_URL: 'https://user:secret@example.test' } },
    { args: ['--setup'], changes: { PUBLIC_BASE_URL: 'https://example.test/?auth=secret' } },
    { args: ['--setup'], changes: { PUBLIC_BASE_URL: 'http://localhost:3000' } },
    { args: ['--private-secret-value'], changes: {} },
  ])('rejects invalid action inputs locally: $args', async ({ args, changes }) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await tracerMain(args, { ...env, ...changes }, fetcher, vi.fn())).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('withholds HTTP response bodies, network errors, and unexpected errors', async () => {
    const privateText = `${env.RETELL_API_KEY} ${env.RETELL_TO_NUMBER} https://user:pass@example.test Private transcript`;
    const cases: (typeof fetch)[] = [
      mockApi([new Response(privateText, { status: 403 })]).fetcher,
      () => Promise.reject(new Error(privateText)),
      mockApi([new Response(privateText)]).fetcher,
    ];
    for (const fetcher of cases) {
      const lines: string[] = [];
      expect(await tracerMain([], env, fetcher, (line) => lines.push(line))).toBe(1);
      expect(lines.join('\n')).not.toContain(privateText);
      expect(lines.join('\n')).not.toContain(env.RETELL_API_KEY);
      expect(lines.join('\n')).not.toContain(env.RETELL_TO_NUMBER);
      expect(lines.join('\n')).toContain('withheld');
    }
  });

  it('never retries a call when Retell times out or rejects it', async () => {
    const api = mockApi([
      ...inventory,
      agent,
      llm,
      new Response('private response', { status: 429 }),
    ]);
    expect(await tracerMain(['--call'], env, api.fetcher, vi.fn())).toBe(1);
    expect(api.requests.filter(({ url }) => url.endsWith('/v2/create-phone-call'))).toHaveLength(1);
  });
});
