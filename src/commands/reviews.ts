import type { Context } from '../lib/context.js';
import { c } from '../lib/ui.js';

export async function reviewsCommand(
  ctx: Context,
  plid: number,
  opts: { page: number; sort?: string },
): Promise<void> {
  const query: Record<string, string | number> = { page: opts.page };
  if (opts.sort) query.sort = opts.sort;
  const data: any = await ctx.client.call('reviews.public', { params: { plid }, query });
  const reviews: any[] = data?.reviews ?? [];
  const count = Number(data?.page_info?.total ?? reviews.length);
  ctx.logger.result(() => {
    process.stdout.write(`\n${c.bold(`${count} reviews`)}\n`);
    for (const review of reviews) {
      const title = review?.text?.title ? ` ${review.text.title}` : '';
      const body = String(review?.text?.body ?? '');
      const snippet = body.length > 140 ? `${body.slice(0, 137)}…` : body;
      process.stdout.write(`  ${c.yellow(`★ ${review?.rating ?? '?'}`)}${title}\n`);
      if (snippet) process.stdout.write(`    ${snippet}\n`);
    }
  }, data);
}
