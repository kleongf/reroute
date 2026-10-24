/**
 * pnpm verify: the single "is this good AND does it run?" gate.
 * Runs each step in order, stops at the first failure, always shuts the app down,
 * and prints a PASS/FAIL summary. Exit code 0 only if every step passed.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort, startApp, TEST_SERVER_ENV, type RunningApp } from './lib/app-process.ts';

type Status = 'PASS' | 'FAIL' | 'SKIP';

interface Step {
  readonly name: string;
  readonly run: () => Promise<void>;
}

interface Result {
  readonly name: string;
  readonly status: Status;
  readonly ms: number;
  readonly detail?: string;
}

const ARTIFACTS = join(process.cwd(), 'artifacts');
const VERIFY_DIR = join(ARTIFACTS, 'verify');
const SERVER_LOG = join(VERIFY_DIR, 'server.log');

function exec(command: string, args: readonly string[], env: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code ?? signal)}`));
    });
  });
}

const pnpmScript = (script: string): Step => ({
  name: script,
  run: () => exec('pnpm', ['run', '--silent', script]),
});

let app: RunningApp | undefined;
let dbDir: string | undefined;

async function cleanup(): Promise<void> {
  const running = app;
  app = undefined;
  if (running !== undefined) await running.stop();
  if (dbDir !== undefined) rmSync(dbDir, { recursive: true, force: true });
  dbDir = undefined;
}

const steps: readonly Step[] = [
  pnpmScript('format:check'),
  pnpmScript('typecheck'),
  pnpmScript('lint'),
  pnpmScript('test'),
  pnpmScript('build'),
  {
    name: 'boot',
    run: async () => {
      const port = await getFreePort();
      dbDir = mkdtempSync(join(tmpdir(), 'reroute-verify-'));
      app = await startApp({
        nodeArgs: ['dist/server.js'],
        port,
        env: { ...TEST_SERVER_ENV, DATABASE_PATH: join(dbDir, 'verify.db'), HEARTBEAT_MS: '500' },
        logFile: SERVER_LOG,
      });
      console.log(`  app healthy at ${app.baseUrl}`);
    },
  },
  {
    name: 'e2e',
    run: async () => {
      if (app === undefined) throw new Error('app is not running');
      await exec('pnpm', ['exec', 'playwright', 'test'], { BASE_URL: app.baseUrl });
    },
  },
  {
    name: 'shutdown',
    run: async () => {
      const running = app;
      app = undefined;
      if (running === undefined) throw new Error('app is not running');
      const exit = await running.stop();
      if (exit.code !== 0) {
        throw new Error(
          `server did not exit cleanly (code ${String(exit.code)}, signal ${String(exit.signal)})`,
        );
      }
    },
  },
];

function fmtMs(ms: number): string {
  return ms < 1_000 ? `${String(Math.round(ms))}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function printSummary(results: readonly Result[], totalMs: number): boolean {
  const ok = results.every((r) => r.status === 'PASS');
  const width = Math.max(...results.map((r) => r.name.length));
  console.log('\n──────── verify summary ────────');
  for (const r of results) {
    const time = r.status === 'SKIP' ? '' : fmtMs(r.ms);
    console.log(`  ${r.status}  ${r.name.padEnd(width)}  ${time}`.trimEnd());
    if (r.detail !== undefined) console.log(`        ${r.detail.split('\n')[0] ?? ''}`);
  }
  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: verify ${ok ? 'succeeded' : 'failed'} in ${fmtMs(totalMs)}`,
  );
  if (!ok) console.log(`Artifacts (screenshots, traces, server log): ${ARTIFACTS}`);
  return ok;
}

async function main(): Promise<number> {
  rmSync(VERIFY_DIR, { recursive: true, force: true });
  mkdirSync(VERIFY_DIR, { recursive: true });

  const results: Result[] = [];
  const started = performance.now();
  let failed = false;

  for (const [index, step] of steps.entries()) {
    if (failed) {
      results.push({ name: step.name, status: 'SKIP', ms: 0 });
      continue;
    }
    console.log(`\n==> [${String(index + 1)}/${String(steps.length)}] ${step.name}`);
    const t0 = performance.now();
    try {
      await step.run();
      results.push({ name: step.name, status: 'PASS', ms: performance.now() - t0 });
    } catch (error) {
      failed = true;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`\n  ${step.name} failed: ${detail}`);
      results.push({ name: step.name, status: 'FAIL', ms: performance.now() - t0, detail });
    }
  }

  await cleanup();
  const ok = printSummary(results, performance.now() - started);
  writeFileSync(join(VERIFY_DIR, 'summary.json'), JSON.stringify({ ok, results }, null, 2));
  return ok ? 0 : 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`\nverify interrupted (${signal}); stopping app...`);
    void cleanup().finally(() => process.exit(130));
  });
}

process.exitCode = await main();
