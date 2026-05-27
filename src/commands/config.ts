import type { Context } from '../lib/context.js';
import { c } from '../lib/ui.js';
import { DEFAULTS } from '../lib/api-client.js';
import {
  configDir,
  configPath,
  credentialsPath,
  loadCredentials,
  loadPreferences,
  preferencesPath,
} from '../lib/config.js';

const REDACTED = '••••••••';

/**
 * `takealot config show` — print effective settings and credential status with
 * every secret (password, tokens) redacted. Safe to paste into a bug report.
 */
export async function configShow(ctx: Context): Promise<void> {
  const config = ctx.config;
  const creds = loadCredentials();
  const prefs = loadPreferences();

  const settings = {
    searchApiBase: config.searchApiBase ?? DEFAULTS.searchApiBase,
    mobileApiBase: config.mobileApiBase ?? DEFAULTS.mobileApiBase,
    platform: config.platform ?? DEFAULTS.platform,
    preferredBrands: config.preferredBrands ?? [],
    defaultCardReference: config.defaultCardReference ?? null,
  };

  const credentials = creds
    ? {
        email: creds.email,
        password: REDACTED,
        customerId: creds.tokens?.customerId ?? null,
        hasTokens: Boolean(creds.tokens),
        jwtExpiresAt: creds.tokens?.jwtExpiresAt
          ? new Date(creds.tokens.jwtExpiresAt).toISOString()
          : null,
      }
    : null;

  const data = {
    configDir: configDir(),
    files: {
      config: configPath(),
      credentials: credentialsPath(),
      preferences: preferencesPath(),
    },
    settings,
    credentials,
    preferences: { count: prefs.length },
  };

  ctx.logger.result(
    () => {
      process.stdout.write(`\n${c.bold('⚙ Configuration')}\n`);
      process.stdout.write(`  ${c.dim('dir')}            ${data.configDir}\n\n`);

      process.stdout.write(`${c.bold('Settings')}\n`);
      process.stdout.write(`  ${c.dim('search API')}     ${settings.searchApiBase}\n`);
      process.stdout.write(`  ${c.dim('mobile API')}     ${settings.mobileApiBase}\n`);
      process.stdout.write(`  ${c.dim('platform')}       ${settings.platform}\n`);
      process.stdout.write(
        `  ${c.dim('preferred')}      ${settings.preferredBrands.length ? settings.preferredBrands.join(', ') : c.gray('(none)')}\n`,
      );
      process.stdout.write(
        `  ${c.dim('default card')}   ${settings.defaultCardReference ?? c.gray('(none)')}\n\n`,
      );

      process.stdout.write(`${c.bold('Credentials')}\n`);
      if (!credentials) {
        process.stdout.write(`  ${c.yellow('none saved')} — run \`takealot login\`.\n`);
      } else {
        process.stdout.write(`  ${c.dim('email')}          ${credentials.email}\n`);
        process.stdout.write(`  ${c.dim('password')}       ${credentials.password}\n`);
        process.stdout.write(`  ${c.dim('customer id')}    ${credentials.customerId ?? c.gray('(unknown)')}\n`);
        process.stdout.write(
          `  ${c.dim('tokens')}         ${credentials.hasTokens ? c.green('cached') : c.gray('none')}` +
            (credentials.jwtExpiresAt ? c.dim(` (jwt exp ${credentials.jwtExpiresAt})`) : '') +
            '\n',
        );
      }

      process.stdout.write(`\n${c.bold('Preferences')}\n`);
      process.stdout.write(`  ${c.dim('products')}       ${prefs.length}\n`);
    },
    data,
  );
}
