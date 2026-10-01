import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { IdParamSchema, WalletCreateSchema, WalletUpdateSchema } from 'shared';
import { db } from '../db';
import { transactions, wallets } from '../db/schema';
import { validate } from '../lib/validate';
import { invalidateContainsCache } from '../services/classifier';
import { assertDemoRoom } from '../services/demo';

export const walletsRoute = new Hono()
  .get('/', async (c) => {
    const rows = await db.select().from(wallets).orderBy(wallets.id);
    return c.json(rows);
  })
  .get('/:id', validate('param', IdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db.select().from(wallets).where(eq(wallets.id, id)).limit(1);
    if (!row) throw new HTTPException(404, { message: 'wallet_not_found' });
    return c.json(row);
  })
  .post('/', validate('json', WalletCreateSchema), async (c) => {
    const body = c.req.valid('json');
    assertDemoRoom('wallets');
    const [row] = await db
      .insert(wallets)
      .values({
        name: body.name,
        budget: body.budget,
        currency: body.currency ?? 'EUR',
        color: body.color,
        icon: body.icon ?? null,
        isActive: body.isActive ?? true,
      })
      .returning();
    return c.json(row, 201);
  })
  .put(
    '/:id',
    validate('param', IdParamSchema),
    validate('json', WalletUpdateSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const now = new Date().toISOString();
      const [row] = await db
        .update(wallets)
        .set({ ...body, updatedAt: now })
        .where(eq(wallets.id, id))
        .returning();
      if (!row) throw new HTTPException(404, { message: 'wallet_not_found' });
      // Cached contains rules carry their joined wallet row.
      invalidateContainsCache();
      return c.json(row);
    },
  )
  .delete('/:id', validate('param', IdParamSchema), (c) => {
    const { id } = c.req.valid('param');
    const now = new Date().toISOString();
    // Synchronous: drizzle's bun-sqlite transaction can't await. On its own,
    // ON DELETE SET NULL would leave the wallet's transactions "classified"
    // with no wallet, invisible to both the stats and the pending queue.
    const deleted = db.transaction((tx) => {
      tx.update(transactions)
        .set({ walletId: null, status: 'pending', classifiedAt: null, updatedAt: now })
        .where(
          and(
            eq(transactions.walletId, id),
            inArray(transactions.status, ['classified', 'pending_confirmation']),
          ),
        )
        .run();
      return tx.delete(wallets).where(eq(wallets.id, id)).returning().get();
    });
    if (!deleted) throw new HTTPException(404, { message: 'wallet_not_found' });
    // The FK cascade removed the wallet's rules; a stale cached contains rule
    // would classify into the deleted wallet and fail the next insert.
    invalidateContainsCache();
    return c.json({ ok: true });
  });
