import { Hono } from 'hono';
import type { Meta } from 'shared';
import { config } from '../config';
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_SAMPLES } from '../db/seed-demo';
import { nextResetAt } from '../services/demo';

// Public: the login page reads it before anyone signs in. The demo login is
// published on purpose; outside demo mode nothing here is.
export const metaRoute = new Hono().get('/', (c) => {
  const meta: Meta = config.DEMO_MODE
    ? {
        demo: true,
        demoLogin: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
        resetsAt: nextResetAt(new Date()).toISOString(),
        samples: DEMO_SAMPLES,
      }
    : { demo: false, demoLogin: null, resetsAt: null, samples: [] };
  return c.json(meta);
});
