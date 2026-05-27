import type { Context } from '../lib/context.js';
import { c } from '../lib/ui.js';
import { promptPassword, promptText } from '../lib/prompt.js';

/**
 * `takealot login` — force a fresh login, rotating the cached token set. With
 * `--reset` it re-prompts for email/password first (use when the stored
 * credentials are wrong or you're switching accounts).
 */
export async function loginCommand(ctx: Context, opts: { reset?: boolean }): Promise<void> {
  if (opts.reset) {
    if (ctx.logger.isJson || !process.stdin.isTTY) {
      throw new Error('--reset needs an interactive terminal to capture new credentials.');
    }
    ctx.logger.info('Re-entering Takealot credentials…');
    const email = await promptText('Takealot email: ');
    const password = await promptPassword('Takealot password: ');
    if (!email || !password) throw new Error('Email and password are required.');
    ctx.setCredentials(email, password);
  }

  ctx.logger.info('🔐 Logging in…');
  const customerId = await ctx.login();

  ctx.logger.result(
    () => {
      process.stdout.write(`${c.green('✓')} Logged in as customer ${c.bold(String(customerId))}.\n`);
    },
    { loggedIn: true, customerId },
  );
}
