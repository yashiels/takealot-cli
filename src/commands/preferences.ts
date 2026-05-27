import type { Context } from '../lib/context.js';
import { c } from '../lib/ui.js';
import { loadPreferences, savePreferences } from '../lib/config.js';
import { mergePreferences } from '../lib/preferences.js';

/**
 * `takealot preferences refresh` — pull order history and fold every purchased
 * product into the local preference cache (never drops existing entries). The
 * cache is what `cart add` uses to bias search results toward what you've
 * bought before.
 */
export async function preferencesRefresh(ctx: Context): Promise<void> {
  await ctx.ensureCredentials();
  ctx.logger.info('🧠 Rebuilding preferences from order history…');

  const orders = await ctx.client.fetchOrders();
  const fresh = ctx.client.toPreferenceItems(orders);
  const existing = loadPreferences();
  const { merged, added } = mergePreferences(existing, fresh);
  savePreferences(merged);

  ctx.logger.result(
    () => {
      process.stdout.write(
        `${c.green('✓')} Preferences updated: ${c.bold(String(merged.length))} products ` +
          `${c.dim(`(${added} new, from ${orders.length} orders)`)}\n`,
      );
    },
    { total: merged.length, added, ordersScanned: orders.length },
  );
}

/** `takealot preferences show` — list the products currently in the cache. */
export async function preferencesShow(ctx: Context): Promise<void> {
  const items = loadPreferences();
  ctx.logger.result(
    () => {
      if (!items.length) {
        process.stdout.write('\n🧠 No preferences yet — run `takealot preferences refresh`.\n');
        return;
      }
      process.stdout.write(`\n${c.bold('🧠 Preferences')} ${c.dim(`(${items.length} products)`)}\n\n`);
      items.forEach((p) => {
        const brand = p.brand ? ` ${c.dim(p.brand)}` : '';
        process.stdout.write(`  • ${p.title}${brand}  ${c.gray(`id ${p.productId}`)}\n`);
      });
    },
    { count: items.length, items },
  );
}
