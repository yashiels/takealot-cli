import { Context, OtpFlowError, type LoginOutcome } from '../lib/context.js';
import { c } from '../lib/ui.js';
import { promptPassword, promptText } from '../lib/prompt.js';

/**
 * `takealot login` — authenticate, establishing/refreshing device trust.
 *
 * Two-step 2FA for headless agents (no TTY):
 *   1. `takealot login --json` → if 2FA is needed, emits
 *      `{ "status": "otp_required", "challenge": "<nonce>", "otpSentTo": …, "expiresInSec": N }`
 *      and exits 0. The user reads the OTP off their phone and hands it back.
 *   2. `takealot login --otp <code> --challenge <nonce>` (or `TAKEALOT_OTP` +
 *      `TAKEALOT_CHALLENGE`) completes it. The `--challenge` is REQUIRED and must
 *      equal the emitted nonce, so a completion can never hit another challenge.
 * Once 2FA is completed with device trust, later logins skip the OTP entirely.
 *
 * `--otp` is convenient but leaks via the process list / shell history — prefer
 * `TAKEALOT_OTP` + `TAKEALOT_CHALLENGE` in automation.
 */
export async function loginCommand(
  ctx: Context,
  opts: { reset?: boolean; otp?: string; challenge?: string },
): Promise<void> {
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

  const otp = opts.otp ?? process.env.TAKEALOT_OTP;
  const challenge = opts.challenge ?? process.env.TAKEALOT_CHALLENGE;

  try {
    if (otp) {
      ctx.logger.info('🔐 Completing two-step verification…');
      emit(ctx, await ctx.finishLogin(otp, challenge));
      return;
    }

    const headless = ctx.logger.isJson || !process.stdin.isTTY;
    ctx.logger.info('🔐 Logging in…');
    const outcome = headless
      ? await ctx.startLogin()
      : ({ status: 'ok', customerId: await ctx.login() } as LoginOutcome);
    emit(ctx, outcome);
  } catch (err) {
    if (err instanceof OtpFlowError) {
      // A structured 2FA error — surface the code machine-readably, non-zero exit.
      if (!process.exitCode) process.exitCode = 1;
      ctx.logger.result(
        () => process.stderr.write(`${c.red('✖')} ${err.message}\n`),
        { status: err.code, error: err.message },
      );
      return;
    }
    throw err;
  }
}

function emit(ctx: Context, outcome: LoginOutcome): void {
  if (outcome.status === 'ok') {
    ctx.logger.result(
      () =>
        process.stdout.write(
          `${c.green('✓')} Logged in as customer ${c.bold(String(outcome.customerId))}.\n`,
        ),
      { loggedIn: true, status: 'ok', customerId: outcome.customerId },
    );
    return;
  }
  // otp_required — the headless hand-off. Exit 0; the caller supplies the OTP next.
  ctx.logger.result(
    () => {
      process.stdout.write(`\n${c.yellow('🔐 Two-step verification required.')}\n`);
      if (outcome.otpSentTo) process.stdout.write(`   OTP sent to ${c.bold(outcome.otpSentTo)}.\n`);
      process.stdout.write(
        `   Complete it with:\n     ${c.bold(`takealot login --otp <code> --challenge ${outcome.challenge}`)}\n` +
          `   (or set ${c.dim('TAKEALOT_OTP')} + ${c.dim('TAKEALOT_CHALLENGE')}). Expires in ~${outcome.expiresInSec}s.\n`,
      );
    },
    outcome,
  );
}
