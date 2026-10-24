import { parseArgs } from 'node:util';
import { z } from 'zod';

const selector = z.string().min(1);

export const stepSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('goto'), path: z.string().min(1) }),
  z.strictObject({ action: z.literal('click'), selector }),
  z.strictObject({ action: z.literal('fill'), selector, value: z.string() }),
  z.strictObject({ action: z.literal('press'), selector, key: z.string().min(1) }),
  z.strictObject({ action: z.literal('wait'), ms: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal('waitFor'), selector }),
  z.strictObject({
    action: z.literal('screenshot'),
    name: z.string().regex(/^[\w.-]+$/, 'use letters, digits, dot, dash, underscore'),
    fullPage: z.boolean().optional(),
  }),
]);

export type Step = z.infer<typeof stepSchema>;

export const stepsFileSchema = z.array(stepSchema);

export interface ExploreOptions {
  readonly headed: boolean;
  readonly help: boolean;
  readonly url: string | undefined;
  readonly stepsFile: string | undefined;
  /** Steps given as CLI flags, in the order they appeared. */
  readonly cliSteps: readonly Step[];
}

/** Separator for flags that take two values, e.g. `--fill "#name::Alice"`. */
export const PAIR_SEPARATOR = '::';

function splitPair(flag: string, raw: string): [string, string] {
  const at = raw.indexOf(PAIR_SEPARATOR);
  if (at <= 0) {
    throw new Error(`--${flag} expects "<selector>${PAIR_SEPARATOR}<value>", got "${raw}"`);
  }
  return [raw.slice(0, at), raw.slice(at + PAIR_SEPARATOR.length)];
}

function parseMs(raw: string): number {
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`--wait expects milliseconds, got "${raw}"`);
  return ms;
}

export function parseExploreArgs(argv: readonly string[]): ExploreOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      headed: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      url: { type: 'string' },
      steps: { type: 'string' },
      goto: { type: 'string', multiple: true },
      click: { type: 'string', multiple: true },
      fill: { type: 'string', multiple: true },
      press: { type: 'string', multiple: true },
      wait: { type: 'string', multiple: true },
      'wait-for': { type: 'string', multiple: true },
      screenshot: { type: 'string', multiple: true },
    },
  });

  const cliSteps: Step[] = [];
  for (const token of tokens) {
    if (token.kind !== 'option' || token.value === undefined) continue;
    const raw = token.value;
    let step: unknown;
    switch (token.name) {
      case 'goto':
        step = { action: 'goto', path: raw };
        break;
      case 'click':
        step = { action: 'click', selector: raw };
        break;
      case 'fill': {
        const [sel, value] = splitPair('fill', raw);
        step = { action: 'fill', selector: sel, value };
        break;
      }
      case 'press': {
        const [sel, key] = splitPair('press', raw);
        step = { action: 'press', selector: sel, key };
        break;
      }
      case 'wait':
        step = { action: 'wait', ms: parseMs(raw) };
        break;
      case 'wait-for':
        step = { action: 'waitFor', selector: raw };
        break;
      case 'screenshot':
        step = { action: 'screenshot', name: raw };
        break;
      default:
        continue;
    }
    cliSteps.push(stepSchema.parse(step));
  }

  return {
    headed: values.headed,
    help: values.help,
    url: values.url,
    stepsFile: values.steps,
    cliSteps,
  };
}
