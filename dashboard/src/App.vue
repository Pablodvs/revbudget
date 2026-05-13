<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { authClient } from './lib/auth';
import { useThemeStore } from './stores/theme';

const theme = useThemeStore();
theme.init();

const router = useRouter();
const route = useRoute();
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
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="min-h-full flex flex-col">
    <header
      v-if="user && !isPublic"
      class="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-10"
    >
      <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div class="flex items-center gap-8">
          <RouterLink to="/" class="text-lg font-semibold tracking-tight">
            💰 <span class="ml-1">RevBudget</span>
          </RouterLink>
          <nav class="flex items-center gap-1">
            <RouterLink
              v-for="l in navLinks"
              :key="l.to"
              :to="l.to"
              class="px-3 py-1.5 text-sm rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
              active-class="!text-zinc-100 !bg-zinc-900"
            >
              {{ l.label }}
            </RouterLink>
          </nav>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-zinc-500 hidden md:inline">{{ user.email }}</span>
          <button
            class="text-sm px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
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
    <main class="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
      <RouterView />
    </main>
  </div>
</template>
