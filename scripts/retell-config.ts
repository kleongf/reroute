import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

/** Generates configuration only; never changes an account or places a call. */
export function buildRetellConfig(baseUrl: string) {
  const base = z.url().parse(baseUrl).replace(/\/$/, '');
  if (new URL(base).protocol !== 'https:')
    throw new Error('Retell callbacks require an HTTPS URL.');
  const prompt = ['common', 'offer', 'at-risk-check', 'release', 'escalation', 'inbound']
    .map((name) =>
      readFileSync(
        fileURLToPath(new URL(`../src/retell/prompts/${name}.md`, import.meta.url)),
        'utf8',
      ),
    )
    .join('\n\n');
  const statusProperties = {
    capacity: { type: 'integer', minimum: 0 },
    available_from: { type: 'string', format: 'date-time' },
    available_until: { type: 'string', format: 'date-time' },
  };
  const tools = [
    {
      name: 'get_my_jobs',
      description: 'Get this caller’s Jobs from the backend.',
      properties: {},
      required: [],
    },
    {
      name: 'report_disruption',
      description: 'Report a confirmed Disruption and whether parcels have been collected.',
      properties: {
        job_id: { type: 'string' },
        reason: { type: 'string' },
        collected: { type: 'boolean' },
      },
      required: ['job_id', 'reason', 'collected'],
    },
    {
      name: 'confirm_on_track',
      description:
        'Record the Driver’s clear confirmation that an At Risk Job can still meet its deadline.',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
    {
      name: 'report_status',
      description: 'Record explicitly stated free capacity or availability.',
      properties: statusProperties,
      required: [],
    },
    {
      name: 'accept_offer',
      description: 'Only after a clear yes to this Offer, ask the backend to authorize it.',
      properties: { offer_id: { type: 'string' } },
      required: ['offer_id'],
    },
    {
      name: 'decline_offer',
      description:
        'Only for call_kind=offer with a supplied Offer ID: decline that Offer. Never use for an at_risk_check; use report_disruption for a Driver who cannot complete their existing Job.',
      properties: {
        offer_id: { type: 'string' },
        reason: { type: 'string' },
        ...statusProperties,
      },
      required: ['offer_id'],
    },
  ];
  return {
    llm: {
      general_prompt: prompt,
      default_dynamic_variables: {
        call_kind: 'inbound',
        driver_id: '',
        driver_name: '',
        job_id: '',
        job_label: '',
        pickup_name: '',
        offer_id: '',
        parcels: '',
        deadline_spoken: '',
        eta_spoken: '',
        delay_minutes: '',
        reason: '',
      },
      general_tools: [
        ...tools.map((tool) => ({
          type: 'custom',
          name: tool.name,
          description: tool.description,
          url: `${base}/tools/${tool.name}`,
          method: 'POST',
          args_at_root: false,
          parameters: {
            type: 'object',
            properties: tool.properties,
            required: tool.required,
            additionalProperties: false,
          },
          timeout_ms: 5000,
          speak_during_execution: false,
          speak_after_execution: true,
        })),
        { type: 'end_call', name: 'end_call', description: 'End the call.' },
      ],
    },
    agent: {
      webhook_url: `${base}/webhooks/retell`,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed', 'transcript_updated'],
      webhook_timeout_ms: 10000,
      end_call_after_silence_ms: 30000,
      max_call_duration_ms: 120000,
      voicemail_option: null,
      call_screening_option: {
        agent_identity: 'Reroute, an AI fleet dispatcher',
        call_purpose: 'delivery coordination for this Driver',
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env['PUBLIC_BASE_URL'];
  if (!base) throw new Error('Set PUBLIC_BASE_URL to the public HTTPS callback URL.');
  process.stdout.write(JSON.stringify(buildRetellConfig(base), null, 2) + '\n');
}
