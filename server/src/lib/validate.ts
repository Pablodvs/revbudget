import { zValidator } from '@hono/zod-validator';
import type { Env, ValidationTargets } from 'hono';
import type { ZodIssue, ZodSchema } from 'zod';

type RequestIdEnv = Env & { Variables: { requestId: string } };

// Zod's enum message lists every option and quotes the received input back.
const issueMessage = (i: ZodIssue) =>
  i.code === 'invalid_enum_value' ? 'Invalid value' : i.message;

// zValidator with the app's error contract. Its default 400 echoes the raw
// ZodError (received values, full enum listings) in a shape no other error
// shares; this reports only where and why:
// { error: 'validation_failed', issues: [{ path, message }], requestId }.
export function validate<T extends ZodSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator<T, Target, RequestIdEnv, string>(target, schema, (result, c) => {
    if (result.success) return;
    return c.json(
      {
        error: 'validation_failed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: issueMessage(i),
        })),
        requestId: c.get('requestId'),
      },
      400,
    );
  });
}
