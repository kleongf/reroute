/** Recorded fallback only: real HTTP/backend, fake VoicePort, scripted transcript, no live calls. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';
import { getFreePort, startApp, TEST_SERVER_ENV } from './lib/app-process.ts';

const out = join(process.cwd(), 'artifacts', 'demo-backup');
mkdirSync(out, { recursive: true });
const app = await startApp({
  nodeArgs: ['dist/server.js'],
  port: await getFreePort(),
  env: {
    ...TEST_SERVER_ENV,
    ROUTING: 'off',
    DATABASE_PATH: ':memory:',
    SIMULATED_OFFER_MS: '3000',
  },
  logFile: join(out, 'server.log'),
});
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: app.baseUrl,
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: out, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.addInitScript(`document.addEventListener('DOMContentLoaded', () => {
 const label = document.createElement('div');
 label.textContent = 'RECORDED DEMO · SIMULATED CALLS · silent recording · 1×';
 label.style.cssText = 'position:fixed;bottom:3px;left:50%;transform:translateX(-50%);z-index:99999;background:#111827;color:white;padding:8px 14px;border-radius:6px;font:600 13px system-ui;white-space:nowrap;pointer-events:none';
 document.body.append(label);
});`);
const started = performance.now();
const post = async (path: string, data: unknown = {}) => {
  const response = await context.request.post(path, { data });
  if (!response.ok()) throw new Error(`POST ${path}: HTTP ${String(response.status())}`);
};
const tool = (name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) => ({
  name,
  args,
  call: { call_id: `recorded-${name}`, ...call },
});
const transcript = (
  callId: string,
  driverId: string,
  kind: string,
  entries: { role: 'agent' | 'user'; content: string }[],
) =>
  post('/webhooks/retell', {
    event: 'transcript_updated',
    call: {
      call_id: callId,
      retell_llm_dynamic_variables: { driver_id: driverId, call_kind: kind, job_id: 'J17' },
      transcript_object: entries,
    },
  });
try {
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveText('connected');
  await page.waitForTimeout(2500);
  await post('/api/traffic/us101');
  await expect(page.getByTestId('disruption-card')).toHaveAttribute('data-status', 'at_risk');
  await transcript('recorded-check', 'alex', 'at_risk_check', [
    {
      role: 'agent',
      content: 'US-101 may delay your approach. Can you still make the Oak Street Job?',
    },
    { role: 'user', content: 'No. I’m stuck before Pickup. I haven’t collected the parcels.' },
  ]);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(out, 'at-risk.png') });
  await post(
    '/tools/report_disruption',
    tool(
      'report_disruption',
      { job_id: 'J17', reason: 'stuck before Pickup behind the US-101 closure', collected: false },
      { from_number: TEST_SERVER_ENV.DRIVER_PHONE_ALEX },
    ),
  );
  await expect(page.getByTestId('call-title')).toHaveText('Offer to Blair');
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('call-title')).toHaveText('Offer to Casey');
  const state = (await (await context.request.get('/api/state')).json()) as StateSnapshot;
  const offer = state.placements
    .at(-1)
    ?.offers.find((entry) => entry.driverId === 'casey' && entry.status === 'pending');
  if (!offer?.callId) throw new Error('Missing pending Casey Offer');
  const deadline = state.jobs.find((job) => job.id === 'J17')?.deadline;
  if (!deadline) throw new Error('Missing Job deadline');
  const spoken = new Date(deadline).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
  });
  await transcript(offer.callId, 'casey', 'offer', [
    {
      role: 'agent',
      content: `Can you collect two parcels at Oak Street Florist, due by ${spoken}?`,
    },
    { role: 'user', content: 'Yes, I’ll take it.' },
  ]);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(out, 'offer.png') });
  await post('/tools/accept_offer', tool('accept_offer', { offer_id: offer.id }));
  await expect(page.getByTestId('placement-status')).toHaveAttribute('data-status', 'placed');
  await transcript('recorded-release', 'alex', 'release', [
    { role: 'agent', content: 'Casey has the Oak Street Job; you’re off it.' },
    { role: 'user', content: 'Thanks, understood.' },
  ]);
  await expect(page.getByTestId('demo-progress')).toHaveAttribute('data-complete', 'true');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(out, 'placed.png') });
  expect(errors).toEqual([]);
  const video = page.video();
  await context.close();
  await video?.saveAs(join(out, 'reroute-recorded-simulated-calls.webm'));
  writeFileSync(
    join(out, 'provenance.json'),
    JSON.stringify(
      {
        recorded: true,
        calls: 'simulated with FakeVoice; scripted transcript webhooks',
        realCalls: 0,
        audio: false,
        playbackSpeed: 1,
        elapsedSeconds: Math.round((performance.now() - started) / 1000),
        consoleErrors: errors,
        scenario:
          'US-101 approach closure → Alex checked → Blair full van → Casey Accepted → Alex release reply',
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(out, 'index.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Reroute — recorded demo, simulated calls</title><body style="margin:0;background:#111;color:white;font-family:system-ui"><p style="text-align:center">Recorded demo · simulated calls · silent recording · 1×</p><video controls style="width:100%;max-height:90vh" src="reroute-recorded-simulated-calls.webm"></video></body></html>',
  );
  console.log(`Recorded offline backup: ${join(out, 'reroute-recorded-simulated-calls.webm')}`);
} finally {
  await browser.close();
  await app.stop();
}
