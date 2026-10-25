/**
 * pnpm ui:explore: boot the app, drive the dashboard in Playwright, and save
 * screenshots + browser console + server logs under artifacts/explore/<timestamp>/.
 * See scripts/README.md for usage.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { getFreePort, startApp, TEST_SERVER_ENV, type RunningApp } from './lib/app-process.ts';
import { parseExploreArgs, stepsFileSchema, type Step } from './lib/steps.ts';

const USAGE = `Usage: pnpm ui:explore [options] [steps...]

Options:
  --headed                 Show the browser window (default: headless)
  --url <baseUrl>          Use an already running server instead of booting one
  --steps <file.json>      JSON array of steps (run before CLI steps)
  -h, --help               Show this help

Steps (run in the order given):
  --goto <path>            Navigate to a path, e.g. /
  --click <selector>       Click a Playwright selector
  --fill "<selector>::<value>"
  --press "<selector>::<key>"
  --wait <ms>              Sleep
  --wait-for <selector>    Wait until the selector is visible
  --screenshot <name>      Save <NN>-<name>.png`;

interface ConsoleEntry {
  readonly time: string;
  readonly type: string;
  readonly text: string;
  readonly location?: string;
}

async function runStep(page: Page, step: Step, shoot: (name: string) => Promise<string>) {
  switch (step.action) {
    case 'goto':
      await page.goto(step.path);
      return;
    case 'click':
      await page.locator(step.selector).click();
      return;
    case 'fill':
      await page.locator(step.selector).fill(step.value);
      return;
    case 'press':
      await page.locator(step.selector).press(step.key);
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'waitFor':
      await page.locator(step.selector).waitFor({ state: 'visible' });
      return;
    case 'screenshot':
      await shoot(step.name);
      return;
    case 'post': {
      const res = await page.request.post(step.path, { data: step.body ?? {} });
      if (!res.ok()) throw new Error(`POST ${step.path} → ${String(res.status())}`);
      return;
    }
  }
}

async function main(): Promise<number> {
  const options = parseExploreArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const fileSteps =
    options.stepsFile === undefined
      ? []
      : stepsFileSchema.parse(JSON.parse(readFileSync(options.stepsFile, 'utf8')));
  const steps: readonly Step[] = [...fileSteps, ...options.cliSteps];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'artifacts', 'explore', stamp);
  mkdirSync(outDir, { recursive: true });
  const serverLog = join(outDir, 'server.log');
  const consoleLog = join(outDir, 'console.jsonl');

  let app: RunningApp | undefined;
  let baseUrl = options.url;
  if (baseUrl === undefined) {
    // The server serves the web/ build from dist/web at /.
    execFileSync('pnpm', ['--filter', '@reroute/web', 'build'], { stdio: 'ignore' });
    app = await startApp({
      nodeArgs: ['--import', 'tsx', 'src/server.ts'],
      port: await getFreePort(),
      env: { ...TEST_SERVER_ENV, DATABASE_PATH: join(outDir, 'explore.db') },
      logFile: serverLog,
    });
    baseUrl = app.baseUrl;
  }

  const consoleEntries: ConsoleEntry[] = [];
  const screenshots: string[] = [];
  const stepResults: { step: Step; ok: boolean; error?: string }[] = [];
  let shotIndex = 0;
  let ok = true;

  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const page = await browser.newPage({
      baseURL: baseUrl,
      viewport: { width: 1280, height: 800 },
    });
    const record = (type: string, text: string, location?: string): void => {
      const entry: ConsoleEntry = { time: new Date().toISOString(), type, text };
      consoleEntries.push(location === undefined ? entry : { ...entry, location });
    };
    page.on('console', (msg) => {
      const loc = msg.location();
      record(msg.type(), msg.text(), `${loc.url}:${String(loc.lineNumber)}`);
    });
    page.on('pageerror', (error) => {
      record('pageerror', error.message);
    });
    page.on('requestfailed', (req) => {
      record('requestfailed', `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`);
    });

    const shoot = async (name: string): Promise<string> => {
      const file = join(outDir, `${String(shotIndex++).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      screenshots.push(file);
      return file;
    };

    await page.goto('/');
    await shoot('initial');

    for (const step of steps) {
      try {
        await runStep(page, step, shoot);
        stepResults.push({ step, ok: true });
      } catch (error) {
        ok = false;
        const message = error instanceof Error ? error.message : String(error);
        stepResults.push({ step, ok: false, error: message });
        console.error(`step failed: ${JSON.stringify(step)}\n  ${message}`);
        await shoot('error').catch(() => undefined);
        break;
      }
    }
    if (ok) await shoot('final');
  } finally {
    await browser.close();
    await app?.stop();
    writeFileSync(consoleLog, consoleEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(
      join(outDir, 'summary.json'),
      JSON.stringify(
        { ok, baseUrl, steps: stepResults, screenshots, consoleLog, serverLog },
        null,
        2,
      ),
    );
  }

  const rel = (p: string) => relative(process.cwd(), p);
  const errors = consoleEntries.filter((e) => e.type === 'error' || e.type === 'pageerror');
  console.log(`\nexplore ${ok ? 'OK' : 'FAILED'}: ${rel(outDir)}/`);
  for (const file of screenshots) console.log(`  screenshot  ${rel(file)}`);
  console.log(
    `  console     ${rel(consoleLog)} (${String(consoleEntries.length)} entries, ${String(errors.length)} errors)`,
  );
  if (app !== undefined) console.log(`  server log  ${rel(serverLog)}`);
  console.log(`  summary     ${rel(join(outDir, 'summary.json'))}`);
  return ok ? 0 : 1;
}

process.exitCode = await main();
