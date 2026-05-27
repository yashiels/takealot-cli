/**
 * Minimal interactive prompts over stdin (no dependency).
 * Used on first run to capture the Takealot email/password.
 */

import * as readline from 'node:readline/promises';

export async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await promptText(`${question} ${hint} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Prompt for a secret without echoing it back to the terminal. */
export function promptPassword(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    output.write(question);

    const wasRaw = input.isRaw ?? false;
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';

    const cleanup = (): void => {
      input.removeListener('data', onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case '\n':
          case '\r':
          case '': // Ctrl-D
            output.write('\n');
            cleanup();
            resolve(value);
            return;
          case '': // Ctrl-C
            output.write('\n');
            cleanup();
            reject(new Error('Cancelled'));
            return;
          case '': // Backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            if (ch >= ' ') value += ch;
        }
      }
    };

    input.on('data', onData);
  });
}
