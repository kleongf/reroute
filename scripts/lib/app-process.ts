import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** Asks the OS for a currently free TCP port on localhost. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

export interface StartAppOptions {
  /** Arguments to `node` (e.g. ['dist/server.js'] or ['--import', 'tsx', 'src/server.ts']). */
  readonly nodeArgs: readonly string[];
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Also append server output to this file. */
  readonly logFile?: string;
  /** Echo server output to this process's stdout with a prefix. */
  readonly echo?: boolean;
  readonly healthTimeoutMs?: number;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningApp {
  readonly baseUrl: string;
  readonly port: number;
  /** Everything the server wrote to stdout/stderr so far. */
  logs(): string;
  /** SIGTERM, then SIGKILL after a grace period. Safe to call more than once. */
  stop(graceMs?: number): Promise<ExitInfo>;
}

export async function startApp(options: StartAppOptions): Promise<RunningApp> {
  const { port } = options;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const child = spawn(process.execPath, [...options.nodeArgs], {
    env: { ...process.env, ...options.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so stop() also reaches grandchildren.
    detached: true,
  });

  let output = '';
  let logStream: WriteStream | undefined;
  if (options.logFile !== undefined) logStream = createWriteStream(options.logFile, { flags: 'a' });
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    output += text;
    logStream?.write(text);
    if (options.echo === true) {
      process.stdout.write(text.replace(/^(?=.)/gm, '  [server] '));
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  let exitInfo: ExitInfo | undefined;
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Process group already gone.
    }
  };

  const stop = async (graceMs = 5_000): Promise<ExitInfo> => {
    if (exitInfo === undefined) {
      signalGroup('SIGTERM');
      const result = await Promise.race([exited, delay(graceMs).then(() => undefined)]);
      if (result === undefined) signalGroup('SIGKILL');
    }
    const info = await exited;
    await new Promise<void>((resolve) => {
      if (logStream === undefined) resolve();
      else logStream.end(resolve);
    });
    return info;
  };

  const app: RunningApp = { baseUrl, port, logs: () => output, stop };

  try {
    await waitForHealth(`${baseUrl}/health`, options.healthTimeoutMs ?? 20_000, () => exitInfo);
  } catch (error) {
    await stop();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n--- server output ---\n${output}`, { cause: error });
  }
  return app;
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  exitInfo: () => ExitInfo | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    const exit = exitInfo();
    if (exit !== undefined) {
      throw new Error(
        `Server exited before becoming healthy (code ${String(exit.code)}, signal ${String(exit.signal)})`,
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
      lastError = `HTTP ${String(res.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${url} (${lastError})`);
}
