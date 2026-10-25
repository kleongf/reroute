import { describe, expect, it } from 'vitest';
import { buildRetellConfig } from './retell-config.ts';

describe('Retell fleet configuration', () => {
  it('generates full-envelope HTTPS tools matching the backend status contract', () => {
    const config = buildRetellConfig('https://fleet.example/');
    const status = config.llm.general_tools.find((tool) => tool.name === 'report_status');
    const decline = config.llm.general_tools.find((tool) => tool.name === 'decline_offer');
    expect(status).toMatchObject({
      url: 'https://fleet.example/tools/report_status',
      args_at_root: false,
      timeout_ms: 5000,
      parameters: {
        properties: {
          capacity: { type: 'integer' },
          available_until: { type: 'string' },
          available_from: { type: 'string' },
        },
      },
    });
    expect(decline).toMatchObject({
      parameters: { properties: { capacity: { type: 'integer' } } },
    });
    expect(config.agent.webhook_events).toContain('transcript_updated');
    expect(config.agent).toMatchObject({
      max_call_duration_ms: 120000,
      voicemail_option: null,
      call_screening_option: { agent_identity: 'Reroute' },
    });
    expect(config.llm.default_dynamic_variables.call_kind).toBe('inbound');
    expect(config.llm.general_prompt).toContain('Silence, voicemail');
    for (const kind of ['offer', 'at_risk_check', 'release', 'escalation'])
      expect(config.llm.general_prompt).toContain(`call_kind=${kind}`);
    expect(() => buildRetellConfig('http://fleet.example')).toThrow('HTTPS');
  });
});
