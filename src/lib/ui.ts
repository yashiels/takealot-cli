/**
 * Tiny output helpers: ANSI colors (no dependency) plus a logger that keeps
 * machine-readable JSON on stdout and human/progress noise on stderr.
 */

const colorEnabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stderr.isTTY === true;

function wrap(open: number, close: number) {
  return (s: string | number): string =>
    colorEnabled ? `[${open}m${s}[${close}m` : String(s);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export interface LoggerOptions {
  json: boolean;
  verbose: boolean;
}

/**
 * Routes output by intent:
 * - result()  → stdout (the actual answer; JSON when --json)
 * - info()    → stderr human progress (suppressed under --json)
 * - debug()   → stderr, only with --verbose
 * - error()   → stderr always
 */
export class Logger {
  constructor(private opts: LoggerOptions) {}

  get isJson(): boolean {
    return this.opts.json;
  }

  info(msg: string): void {
    if (!this.opts.json) process.stderr.write(msg + '\n');
  }

  debug(msg: string): void {
    if (this.opts.verbose) process.stderr.write(c.gray(`  · ${msg}`) + '\n');
  }

  warn(msg: string): void {
    process.stderr.write(c.yellow(`⚠ ${msg}`) + '\n');
  }

  error(msg: string): void {
    process.stderr.write(c.red(`✖ ${msg}`) + '\n');
  }

  /** Print the command result. Under --json this prints `data` as JSON. */
  result(human: () => void, data: unknown): void {
    if (this.opts.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      human();
    }
  }
}

/** Format an amount in Rand. */
export function rand(amount: number | undefined): string {
  if (amount === undefined || Number.isNaN(amount)) return 'R—';
  return `R${amount.toFixed(2)}`;
}
