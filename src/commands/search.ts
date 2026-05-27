import type { Context } from '../lib/context.js';
import { c } from '../lib/ui.js';
import type { SearchProduct } from '../types.js';

export function formatPrice(p: SearchProduct): string {
  if (p.prettyPrice) return p.prettyPrice;
  return p.price ? `R${p.price}` : '—';
}

export function stockBadge(inStock: boolean): string {
  return inStock ? c.green('✓ in stock') : c.red('✗ out of stock');
}

export async function searchCommand(
  ctx: Context,
  query: string,
  opts: { limit: number },
): Promise<void> {
  ctx.logger.info(`🔍 Searching "${query}"…`);
  const { products, total } = await ctx.client.search(query, opts.limit);

  ctx.logger.result(
    () => {
      if (!products.length) {
        ctx.logger.info(c.yellow(`No results for "${query}".`));
        return;
      }
      process.stdout.write(`\n${c.bold(`🔍 "${query}"`)} ${c.dim(`(${total} results)`)}\n\n`);
      products.forEach((p, i) => {
        const line = `${c.dim(`${i + 1}.`)} ${p.title}`;
        process.stdout.write(`${line}\n`);
        const meta = [c.cyan(formatPrice(p)), stockBadge(p.inStock)];
        if (p.brand) meta.push(c.dim(p.brand));
        if (p.saving) meta.push(c.green(`-${p.saving}`));
        process.stdout.write(`   ${meta.join('  ')}\n`);
        process.stdout.write(`   ${c.gray(`id ${p.productId}`)}\n\n`);
      });
    },
    { query, total, products },
  );
}
