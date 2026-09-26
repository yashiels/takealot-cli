import type { Context } from '../lib/context.js';
import { UsageError } from '../lib/errors.js';
import { mutateEndpoint, readBodyFromFlags, type CommonFlags } from './generic.js';

export interface WishlistAddFlags extends CommonFlags {
  sku?: number[];
  plid?: number;
}

export interface WishlistMoveFlags extends CommonFlags {
  from?: number;
  to?: number;
  tsin?: number[];
}

export interface WishlistRemoveItemsFlags extends CommonFlags {
  tsin?: number[];
}

const requireIds = (name: string, values: number[], minimum = 1): void => {
  if (values.some((value) => !Number.isSafeInteger(value) || value < minimum)) {
    throw new UsageError(
      minimum > 1
        ? `${name} must be a Takealot id (a positive integer of at least ${String(minimum).length} digits)`
        : `${name} must be a positive integer`,
    );
  }
};

export async function wishlistAdd(
  ctx: Context,
  target: string | undefined,
  legacyGroupId: string | undefined,
  flags: WishlistAddFlags,
): Promise<void> {
  const hasTypedIds = Boolean(flags.sku?.length) || flags.plid !== undefined;
  if (flags.file && hasTypedIds)
    throw new UsageError('use either --file or --sku/--plid, not both');

  let groupId: number | undefined;
  if (target !== undefined) {
    const rawGroupId = target === 'group' ? legacyGroupId : legacyGroupId === undefined ? target : undefined;
    if (rawGroupId === undefined || !/^\d+$/.test(rawGroupId)) {
      throw new UsageError('wishlist add target must be <groupId> or group <groupId>');
    }
    groupId = Number(rawGroupId);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      throw new UsageError('wishlist group id must be a positive integer');
    }
  } else if (legacyGroupId !== undefined) {
    throw new UsageError('wishlist add target must be <groupId> or group <groupId>');
  }

  let body: unknown;
  if (flags.file) {
    body = readBodyFromFlags(flags, true);
  } else {
    if (groupId === undefined) throw new UsageError('typed adds need an explicit <groupId> (see wishlist list); use --file to target the last-used list');
    const skus = [...(flags.sku ?? [])];
    requireIds('--sku', skus, 1000);
    if (flags.plid !== undefined) {
      requireIds('--plid', [flags.plid], 1000);
      skus.push(await ctx.client.skuForPlid(flags.plid));
    }
    requireIds('--sku', skus, 1000);
    if (!skus.length) throw new UsageError('provide at least one --sku, --plid, or --file');
    body = { products: skus.map((sku) => ({ sku })) };
  }

  const id = groupId === undefined ? 'wishlist.items.addLast' : 'wishlist.items.add';
  const params = groupId === undefined ? undefined : { groupId };
  await mutateEndpoint(ctx, id, { params, body }, flags);
}

export async function wishlistMove(ctx: Context, flags: WishlistMoveFlags): Promise<void> {
  const hasTypedIds =
    flags.from !== undefined || flags.to !== undefined || Boolean(flags.tsin?.length);
  if (flags.file && hasTypedIds)
    throw new UsageError('use either --file or --from/--to/--tsin, not both');

  let body: unknown;
  if (flags.file) {
    body = readBodyFromFlags(flags, true);
  } else {
    if (flags.from === undefined) throw new UsageError('provide --from <groupId>');
    if (flags.to === undefined) throw new UsageError('provide --to <groupId>');
    if (!flags.tsin?.length) throw new UsageError('provide at least one --tsin');
    requireIds('--from', [flags.from]);
    requireIds('--to', [flags.to]);
    requireIds('--tsin', flags.tsin, 1000);
    if (flags.from === flags.to) throw new UsageError('--from and --to must be different lists');
    body = { from: flags.from, to: [flags.to], products: flags.tsin.map((tsin) => ({ tsin })) };
  }

  await mutateEndpoint(ctx, 'wishlist.items.move', { body }, flags);
}

export async function wishlistRemoveItems(
  ctx: Context,
  groupId: number,
  flags: WishlistRemoveItemsFlags,
): Promise<void> {
  if (flags.file && flags.tsin?.length)
    throw new UsageError('use either --file or --tsin, not both');
  requireIds('<groupId>', [groupId]);

  let body: unknown;
  if (flags.file) {
    body = readBodyFromFlags(flags, true);
  } else {
    if (!flags.tsin?.length) throw new UsageError('provide at least one --tsin or --file');
    requireIds('--tsin', flags.tsin, 1000);
    body = { products: flags.tsin.map((tsin) => ({ tsin })) };
  }

  await mutateEndpoint(ctx, 'wishlist.items.bulkRemove', { params: { groupId }, body }, flags);
}
