<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
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
