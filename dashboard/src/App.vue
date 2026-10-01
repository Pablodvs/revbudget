<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import { computed, onBeforeUnmount, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useMeta } from './composables/useMeta';
import { authClient } from './lib/auth';
import { useThemeStore } from './stores/theme';

const theme = useThemeStore();
theme.init();

const router = useRouter();
const route = useRoute();
const queryClient = useQueryClient();
const session = authClient.useSession();
const user = computed(() => session.value.data?.user);
const isAdmin = computed(() => user.value?.role === 'admin');
const isPublic = computed(() => Boolean(route.meta.public));

// Dismissed per tab session, so the next visit is told again that the data is fake.
const meta = useMeta();
const BANNER_KEY = 'revbudget:demo-banner-dismissed';
// Storage can throw (blocked site data, some private modes); the banner then
// just shows again next time.
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(BANNER_KEY) === '1';
  } catch {
    return false;
  }
}
const bannerDismissed = ref(readDismissed());
const showBanner = computed(() => Boolean(meta.data.value?.demo) && !bannerDismissed.value);
// The reset is at midnight in the server's timezone, which may not be the
// visitor's, so say how far off it is rather than when. Ticks so an open tab
// counts down.
const now = ref(Date.now());
const clock = setInterval(() => {
  now.value = Date.now();
}, 60_000);
onBeforeUnmount(() => clearInterval(clock));
const bannerText = computed(() => {
  const base = 'Demo · fake data shared with other visitors';
  const ms = Date.parse(meta.data.value?.resetsAt ?? '') - now.value;
  if (!(ms > 0)) return `${base} · resets nightly`;
  const hours = Math.round(ms / 3_600_000);
  const until = hours >= 1 ? `${hours} h` : `${Math.ceil(ms / 60_000)} min`;
  return `${base} · next reset in ${until}`;
});
function dismissBanner() {
  bannerDismissed.value = true;
  try {
    sessionStorage.setItem(BANNER_KEY, '1');
  } catch {}
}

const navLinks = computed(() => {
  const links = [
    { to: '/', label: 'Overview' },
    { to: '/wallets', label: 'Wallets' },
    { to: '/transactions', label: 'Transactions' },
    { to: '/rules', label: 'Rules' },
    { to: '/stats', label: 'Stats' },
  ];
  if (isAdmin.value) links.push({ to: '/users', label: 'Users' });
  return links;
});

async function logout() {
  await authClient.signOut();
  await router.push({ name: 'login' });
  // Don't leave this account's data cached for whoever signs in next.
  queryClient.clear();
}
</script>

<template>
  <div class="min-h-full flex flex-col">
    <section
      v-if="user && !isPublic && showBanner"
      aria-label="Demo notice"
      class="border-b border-emerald-500/20 bg-emerald-500/10 text-sm"
    >
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-2 flex items-start sm:items-center gap-3">
        <p class="flex-1 min-w-0">
          <span class="font-medium text-emerald-300">{{ bannerText }}</span>
          <span class="text-zinc-400">
            · The Telegram side of the flow is shown in the
            <a
              href="https://github.com/Pablodvs/revbudget#readme"
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-zinc-100"
              >README video<span class="sr-only"> (opens in a new tab)</span></a
            >.
          </span>
        </p>
        <button
          type="button"
          aria-label="Dismiss demo notice"
          class="shrink-0 -my-1 h-7 w-7 grid place-items-center rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
          @click="dismissBanner"
        >
          ✕
        </button>
      </div>
    </section>
    <header
      v-if="user && !isPublic"
      class="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-10"
    >
      <div
        class="max-w-6xl mx-auto px-4 sm:px-6 py-2 md:py-0 md:h-14 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-8 gap-y-2"
      >
        <RouterLink to="/" class="text-lg font-semibold tracking-tight shrink-0">
          <span aria-hidden="true">💰</span> <span class="ml-1">RevBudget</span>
        </RouterLink>
        <!-- Full-width, horizontally scrollable second row on phones. The right-edge
             fade signals there's more; it's exactly as wide as the end padding, so the
             last link clears it when scrolled to the end. -->
        <nav
          class="order-last md:order-none w-full md:w-auto md:flex-1 min-w-0 flex items-center gap-1 overflow-x-auto pr-10 md:pr-0 [mask-image:linear-gradient(to_left,transparent,#000_2.5rem)] md:[mask-image:none]"
        >
          <RouterLink
            v-for="l in navLinks"
            :key="l.to"
            :to="l.to"
            class="shrink-0 px-3 py-1.5 text-sm rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
            active-class="!text-zinc-100 !bg-zinc-900"
          >
            {{ l.label }}
          </RouterLink>
        </nav>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-zinc-400 hidden lg:inline">{{ user.email }}</span>
          <button
            class="text-sm px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
            :aria-label="theme.mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="theme.toggle()"
          >
            {{ theme.mode === 'dark' ? '☀️' : '🌙' }}
          </button>
          <button
            class="text-sm px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
            @click="logout"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
    <main class="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <RouterView />
    </main>
  </div>
</template>
