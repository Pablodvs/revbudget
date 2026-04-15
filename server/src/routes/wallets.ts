import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { IdParamSchema, WalletCreateSchema, WalletUpdateSchema } from 'shared';
import { db } from '../db';
import { wallets } from '../db/schema';

export const walletsRoute = new Hono()
  .get('/', async (c) => {
    const rows = await db.select().from(wallets).orderBy(wallets.id);
    return c.json(rows);
  })
  .get('/:id', zValidator('param', IdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db.select().from(wallets).where(eq(wallets.id, id)).limit(1);
    if (!row) throw new HTTPException(404, { message: 'wallet_not_found' });
    return c.json(row);
  })
  .post('/', zValidator('json', WalletCreateSchema), async (c) => {
    const body = c.req.valid('json');
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
    zValidator('param', IdParamSchema),
    zValidator('json', WalletUpdateSchema),
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
      return c.json(row);
    },
  );
