import { zValidator } from '@hono/zod-validator';
import type { Context, ValidationTargets } from 'hono';
import type { z } from 'zod';

// Zod 3's names for a received type: JSON values, plus NaN from z.coerce.
const receivedType = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isNaN(v) ? 'nan' : typeof v;

// Zod 3's wording, which the dashboard's form errors are phrased around; a
// schema's own messages still win. Zod 4's defaults list every enum option,
// say "received undefined" for a missing field and prefix type errors with
// "Invalid input:".
const apiErrorMap: z.core.$ZodErrorMap = (i) => {
  if (i.input === undefined) return 'Required';
  if (i.code === 'invalid_type') return `Expected ${i.expected}, received ${receivedType(i.input)}`;
  if (i.code === 'invalid_value') return 'Invalid value';
  if (i.code === 'too_small' || i.code === 'too_big') {
    const small = i.code === 'too_small';
    const bound = small ? i.minimum : i.maximum;
    if (i.origin === 'string') {
      const limit = i.exact ? 'exactly' : small ? 'at least' : 'at most';
      return `String must contain ${limit} ${bound} character(s)`;
    }
    if (i.origin === 'number' || i.origin === 'int') {
      return `Number must be ${small ? 'greater' : 'less'} than ${i.inclusive ? 'or equal to ' : ''}${bound}`;
    }
  }
};

// zValidator with the app's error contract. Its default 400 echoes the raw
// ZodError (received values, full enum listings) in a shape no other error
// shares; this reports only where and why:
// { error: 'validation_failed', issues: [{ path, message }], requestId }.
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(
    target,
    schema,
    (result, c: Context) => {
      if (result.success) return;
      return c.json(
        {
          error: 'validation_failed',
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          requestId: c.get('requestId') as string,
        },
        400,
      );
    },
    {
      // zod-validator types this result as a zod v3/v4 conditional that TS
      // can't resolve for a generic T; the hook above sees the real type.
      validationFunction: (s, value) =>
        s.safeParseAsync(value, { error: apiErrorMap }) as Promise<never>,
    },
  );
}
