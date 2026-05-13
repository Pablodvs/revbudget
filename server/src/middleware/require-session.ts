import type { MiddlewareHandler } from 'hono';
import { auth } from '../lib/auth';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export type SessionUser = AuthSession['user'];
export type SessionRow = AuthSession['session'];

export const requireSession: MiddlewareHandler<{
  Variables: { requestId?: string; user: SessionUser; session: SessionRow };
}> = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: 'unauthorized', requestId: c.get('requestId') ?? '' }, 401);
  }
  c.set('user', session.user);
  c.set('session', session.session);
  await next();
};
