import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { authClient } from './lib/auth';
import { router } from './router';
import './styles/main.css';

async function bootstrap() {
  // Resolve the initial session before mount so router guards are synchronous.
  // Cap the wait so a server hiccup can't pin the SPA on a blank screen.
  await Promise.race([
    authClient.getSession(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(VueQueryPlugin, {
    queryClientConfig: {
      defaultOptions: {
        queries: {
          staleTime: 1000 * 30,
          refetchOnWindowFocus: false,
        },
      },
    },
  });
  app.mount('#app');
}

bootstrap();
