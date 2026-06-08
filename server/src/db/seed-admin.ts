import { config } from '../config';
import { auth } from '../lib/auth';
import { log } from '../lib/log';
import { db } from './index';
import { user } from './schema';

export async function seedBootstrapAdmin(): Promise<void> {
  const email = config.BOOTSTRAP_ADMIN_EMAIL;
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await db.select({ id: user.id }).from(user).limit(1);
  if (existing.length > 0) return;

  try {
    await auth.api.createUser({
      body: { email, password, name: email.split('@')[0] ?? email, role: 'admin' },
    });
    log.info('boot', 'bootstrap_admin_created', { email });
  } catch (err) {
    log.error('boot', 'bootstrap_admin_failed', {
      email,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
