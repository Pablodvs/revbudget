import { eq } from 'drizzle-orm';
import { db } from '../db';
import { user } from '../db/schema';
import { auth } from '../lib/auth';

type Args = { email: string; password?: string; name?: string; role: 'admin' | 'user' };

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
  if (!out.email) printHelpAndExit(1);
  return out as Args;
}

function printHelpAndExit(code: number): never {
  console.error(
    'Usage: bun run create-admin -- --email <email> [--password <pw>] [--name <name>] [--role admin|user]\n' +
      'Omit --password to be prompted with hidden input (keeps it out of ps and shell history).',
  );
  process.exit(code);
}

// Masked TTY prompt so the password never appears in `ps` output or shell
// history (the --password flag stays available for automation).
function promptPassword(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped stdin (e.g. from a secret manager): read the first line.
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        const nl = chunk.indexOf('\n');
        if (nl === -1) {
          buf += chunk;
        } else {
          resolve((buf + chunk.slice(0, nl)).trim());
        }
      });
      process.stdin.on('end', () => resolve(buf.trim()));
    });
  }
  process.stderr.write(promptText);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let buf = '';
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') {
          // Ctrl-C
          cleanup();
          process.exit(130);
        } else if (c === '\r' || c === '\n') {
          cleanup();
          resolve(buf);
          return;
        } else if (c === '\u007f' || c === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const { email, name, role, password: passwordArg } = parseArgs();
  const password = passwordArg ?? (await promptPassword('Password (input hidden): '));
  if (password.length < 12) {
    console.error('[create-admin] password must be at least 12 characters');
    process.exit(1);
  }
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
