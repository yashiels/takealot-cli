import type { Context } from '../lib/context.js';
import { c, rand } from '../lib/ui.js';

/** `takealot orders` — list recent orders, most recent first. */
export async function ordersList(ctx: Context, opts: { limit: number }): Promise<void> {
  await ctx.ensureCredentials();
  ctx.logger.info('📦 Fetching orders…');
  const orders = await ctx.client.fetchOrders();
  const shown = orders.slice(0, opts.limit);

  ctx.logger.result(
    () => {
      if (!orders.length) {
        process.stdout.write('\n📦 No orders found.\n');
        return;
      }
      process.stdout.write(
        `\n${c.bold('📦 Orders')} ${c.dim(`(showing ${shown.length} of ${orders.length})`)}\n\n`,
      );
      shown.forEach((o) => {
        const units = o.items.reduce((n, it) => n + it.quantity, 0);
        process.stdout.write(`${c.bold(`#${o.orderId}`)}  ${c.dim(o.orderDate)}\n`);
        const meta: string[] = [];
        if (o.status) meta.push(o.status);
        if (o.total !== undefined) meta.push(c.cyan(rand(o.total)));
        meta.push(c.dim(`${units} item(s)`));
        process.stdout.write(`   ${meta.join('  ')}\n\n`);
      });
      process.stdout.write(c.dim(`Run \`takealot orders show <id>\` for details.\n`));
    },
    { count: orders.length, orders: shown },
  );
}

/** `takealot orders show <id>` — full detail for one order. */
export async function ordersShow(ctx: Context, orderId: string): Promise<void> {
  await ctx.ensureCredentials();
  ctx.logger.info(`📦 Fetching order ${orderId}…`);
  const order = await ctx.client.getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found.`);

  ctx.logger.result(
    () => {
      process.stdout.write(`\n${c.bold(`📦 Order #${order.orderId}`)}  ${c.dim(order.orderDate)}\n`);
      if (order.status) process.stdout.write(`   ${order.status}\n`);
      process.stdout.write('\n');
      order.items.forEach((it) => {
        const brand = it.brand ? ` ${c.dim(it.brand)}` : '';
        process.stdout.write(`  • ${it.quantity} × ${it.title}${brand}  ${c.cyan(rand(it.unitPrice))}\n`);
        process.stdout.write(`    ${c.gray(`id ${it.productId}`)}\n`);
      });
      if (order.total !== undefined) {
        process.stdout.write(`\n  ${c.bold(`Total: ${rand(order.total)}`)}\n`);
      }
    },
    order,
  );
}
