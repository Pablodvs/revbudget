import { db } from './index';
import { wallets } from './schema';

const SEED_WALLETS = [
  { name: 'Food', budget: 35000, color: '#22c55e', icon: '🍕' },
  { name: 'Transport', budget: 15000, color: '#3b82f6', icon: '🚗' },
  { name: 'Entertainment', budget: 20000, color: '#a855f7', icon: '🎮' },
  { name: 'Subscriptions', budget: 5000, color: '#f97316', icon: '📱' },
  { name: 'Home', budget: 25000, color: '#ec4899', icon: '🏠' },
  { name: 'Health', budget: 10000, color: '#14b8a6', icon: '💊' },
  { name: 'Other', budget: 15000, color: '#6b7280', icon: '📦' },
] as const;

async function main() {
  const existing = await db.select().from(wallets).limit(1);
  if (existing.length > 0) {
    console.log('[seed] wallets already present, skipping');
    return;
  }
  await db.insert(wallets).values(
    SEED_WALLETS.map((w) => ({
      name: w.name,
      budget: w.budget,
      currency: 'EUR',
      color: w.color,
      icon: w.icon,
      isActive: true,
    })),
  );
  console.log(`[seed] inserted ${SEED_WALLETS.length} wallets`);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
