import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  IdParamSchema,
  MerchantRuleCreateSchema,
  MerchantRuleUpdateSchema,
  normalizePattern,
} from 'shared';
import { db } from '../db';
import { merchantRules } from '../db/schema';
import { validate } from '../lib/validate';
import { invalidateContainsCache } from '../services/classifier';

export const merchantRulesRoute = new Hono()
  .get('/', async (c) => {
    const rows = await db.select().from(merchantRules).orderBy(merchantRules.id);
    return c.json(rows);
  })
  .post('/', validate('json', MerchantRuleCreateSchema), async (c) => {
    const body = c.req.valid('json');
    const [row] = await db
      .insert(merchantRules)
      .values({
        pattern: normalizePattern(body.pattern),
        walletId: body.walletId,
        matchType: body.matchType,
        requireConfirmation: body.requireConfirmation,
      })
      .returning();
    invalidateContainsCache();
    return c.json(row, 201);
  })
  .put(
    '/:id',
    validate('param', IdParamSchema),
    validate('json', MerchantRuleUpdateSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const now = new Date().toISOString();
      const patch: Partial<typeof merchantRules.$inferInsert> = { updatedAt: now };
      if (body.pattern !== undefined) patch.pattern = normalizePattern(body.pattern);
      if (body.walletId !== undefined) patch.walletId = body.walletId;
      if (body.matchType !== undefined) patch.matchType = body.matchType;
      if (body.requireConfirmation !== undefined)
        patch.requireConfirmation = body.requireConfirmation;
      const [row] = await db
        .update(merchantRules)
        .set(patch)
        .where(eq(merchantRules.id, id))
        .returning();
      if (!row) throw new HTTPException(404, { message: 'rule_not_found' });
      invalidateContainsCache();
      return c.json(row);
    },
  )
  .delete('/:id', validate('param', IdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db.delete(merchantRules).where(eq(merchantRules.id, id)).returning();
    if (!row) throw new HTTPException(404, { message: 'rule_not_found' });
    invalidateContainsCache();
    return c.json({ ok: true });
  });
