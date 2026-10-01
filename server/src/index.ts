import { serveStatic } from 'hono/bun';
import { app } from './app';
import { config } from './config';
import { seedBootstrapAdmin } from './db/seed-admin';
import { log } from './lib/log';
import { NotADemoDatabaseError, scheduleDemoReset, seedDemoIfEmpty } from './services/demo';
import { telegram } from './services/telegram';

const isProduction = config.NODE_ENV === 'production';

if (isProduction) {
  app.use('/assets/*', serveStatic({ root: './dashboard/dist' }));
  app.get('*', serveStatic({ path: './dashboard/dist/index.html' }));
}

const bootstrapped = seedBootstrapAdmin().catch((err) => {
  log.error('boot', 'bootstrap_admin_unexpected_error', {
    err: err instanceof Error ? err.message : String(err),
  });
});

if (config.DEMO_MODE) {
  // After the bootstrap admin, which is only created on a database without
  // users: the demo seed adds one.
  bootstrapped.then(seedDemoIfEmpty).catch((err) => {
    log.error('boot', 'demo_seed_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof NotADemoDatabaseError) process.exit(1);
  });
  scheduleDemoReset();
}

if (telegram) {
  const { bot, chatId } = telegram;
  bot.api
    .getChat(chatId)
    .then((chat) => {
      log.info('boot', 'telegram_chat_ok', { id: chat.id, type: chat.type });
    })
    .catch((err: unknown) => {
      log.error('boot', 'telegram_chat_unreachable', {
        id: chatId,
        err: err instanceof Error ? err.message : String(err),
      });
    });

  bot
    .start({
      onStart: (info) => log.info('boot', 'bot_started', { username: info.username }),
    })
    .catch((err) => {
      log.error('boot', 'bot_start_failed', {
        err: err instanceof Error ? err.message : 'unknown',
      });
    });
} else {
  log.info('boot', 'telegram_disabled', {
    reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set; notifications are stored only',
  });
}

const port = config.PORT;
log.info('boot', 'server_listening', { url: `http://localhost:${port}` });

export default {
  port,
  fetch: app.fetch,
};
