import type { Context } from '../lib/context.js';
import { UsageError } from '../lib/errors.js';
import { gate } from './generic.js';

const cardDto = (card: Awaited<ReturnType<Context['client']['getSavedCards']>>[number]) => ({
  bank: card.bank ?? null,
  scheme: card.cardScheme ?? null,
  last4: card.lastFourDigits ?? null,
  expires: card.cardExpires ?? null,
  selected: Boolean(card.isDefault),
  enabled: card.enabled,
});

export async function cardsCommand(ctx: Context): Promise<void> {
  await ctx.ensureCredentials();
  const cards = (await ctx.client.getSavedCards()).map(cardDto);
  ctx.logger.result(
    () => {
      if (!cards.length) {
        process.stdout.write('No saved cards.\n');
        return;
      }
      for (const card of cards) {
        process.stdout.write(`${card.scheme ?? 'card'} ••••${card.last4 ?? '????'}${card.bank ? ` (${card.bank})` : ''}${card.selected ? ' selected' : ''}\n`);
      }
    },
    cards,
  );
}

export async function cardsRemove(
  ctx: Context,
  last4: string,
  flags: { confirm?: boolean; yes?: boolean },
): Promise<void> {
  if (!/^\d{4}$/.test(last4)) throw new UsageError('--last4 must be exactly four digits');
  await ctx.ensureCredentials();
  const matches = (await ctx.client.getSavedCards()).filter((card) => card.lastFourDigits === last4);
  if (matches.length === 0) throw new UsageError(`no saved card ends in ${last4}`);
  if (matches.length > 1) throw new UsageError(`more than one saved card ends in ${last4}`);
  if (!(await gate(ctx, flags, { action: `remove the saved card ending in ${last4}` }))) return;
  await ctx.client.call('cards.remove', { body: { reference: matches[0]!.reference } });
  ctx.logger.result(() => process.stdout.write(`Removed saved card ending in ${last4}.\n`), { removed: true, last4 });
}
