import { eq } from 'drizzle-orm';
import { db } from '../db';
import { user } from '../db/schema';
import { auth } from '../lib/auth';

type Args = { email: string; password: string; name?: string; role: 'admin' | 'user' };

function parseArgs(): Args {
  const out: Partial<Args> = { role: 'admin' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if ((flag === '--email' || flag === '-e') && next) {
      out.email = next;
      i++;
    } else if ((flag === '--password' || flag === '-p') && next) {
      out.password = next;
      i++;
    } else if ((flag === '--name' || flag === '-n') && next) {
      out.name = next;
      i++;
    } else if (flag === '--role' && (next === 'admin' || next === 'user')) {
      out.role = next;
      i++;
    } else if (flag === '--help' || flag === '-h') {
      printHelpAndExit(0);
    }
  }
  if (!out.email || !out.password) printHelpAndExit(1);
  return out as Args;
}

function printHelpAndExit(code: number): never {
  console.error(
    'Usage: bun run create-admin -- --email <email> --password <pw> [--name <name>] [--role admin|user]',
  );
  process.exit(code);
}

async function main() {
  const { email, password, name, role } = parseArgs();
  const existing = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (existing.length > 0) {
    console.error(`[create-admin] user already exists: ${email}`);
    process.exit(1);
  }
  await auth.api.createUser({
    body: { email, password, name: name ?? email.split('@')[0] ?? email, role },
  });
  console.log(`[create-admin] created ${role}: ${email}`);
}

main().catch((err) => {
  console.error('[create-admin] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
