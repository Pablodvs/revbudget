<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMeta } from '../composables/useMeta';
import { authClient } from '../lib/auth';

const router = useRouter();
const route = useRoute();
const meta = useMeta();
const demoLogin = computed(() => (meta.data.value?.demo ? meta.data.value.demoLogin : null));
const email = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function signIn(creds: { email: string; password: string }) {
  if (submitting.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const res = await authClient.signIn.email(creds);
    if (res.error) {
      error.value = res.error.message ?? 'sign-in failed';
      return;
    }
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    await router.replace(next);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'sign-in failed';
  } finally {
    submitting.value = false;
  }
}

function submit() {
  return signIn({ email: email.value.trim(), password: password.value });
}
</script>

<template>
  <div class="min-h-[80vh] flex items-center justify-center">
    <form
      class="w-full max-w-sm space-y-4 p-6 rounded-xl border border-zinc-800 bg-zinc-950"
      @submit.prevent="submit"
    >
      <div>
        <h1 class="text-xl font-semibold tracking-tight">💰 RevBudget — sign in</h1>
        <p class="mt-1 text-sm text-zinc-400">
          Revolut notifications in, categorised budget out: one-tap Telegram classification, rules
          that learn, and a dashboard.
        </p>
      </div>
      <section
        v-if="demoLogin"
        aria-labelledby="demo-title"
        class="space-y-3 p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5"
      >
        <div>
          <h2 id="demo-title" class="font-semibold">Try the demo</h2>
          <p class="mt-1 text-sm text-zinc-400">Fake data that resets every night.</p>
        </div>
        <dl class="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-sm">
          <dt class="text-zinc-400">Email</dt>
          <dd class="font-mono break-all">{{ demoLogin.email }}</dd>
          <dt class="text-zinc-400">Password</dt>
          <dd class="font-mono break-all">{{ demoLogin.password }}</dd>
        </dl>
        <button
          type="button"
          :disabled="submitting"
          class="w-full px-3 py-2 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400 disabled:opacity-50"
          @click="signIn(demoLogin)"
        >
          Sign in as demo
        </button>
      </section>
      <p
        v-if="demoLogin"
        class="flex items-center gap-3 text-xs text-zinc-400 before:h-px before:flex-1 before:bg-zinc-800 after:h-px after:flex-1 after:bg-zinc-800"
      >
        or use an account
      </p>
      <label class="block space-y-1">
        <span class="text-sm text-zinc-400">Email</span>
        <input
          v-model="email"
          type="email"
          autocomplete="email"
          required
          autofocus
          class="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:border-zinc-600 focus:outline-none"
        />
      </label>
      <label class="block space-y-1">
        <span class="text-sm text-zinc-400">Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          class="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:border-zinc-600 focus:outline-none"
        />
      </label>
      <p v-if="error" role="alert" class="text-sm text-red-400">{{ error }}</p>
      <!-- In the demo, the demo button is the main action; this one steps back. -->
      <button
        type="submit"
        :disabled="submitting"
        class="w-full px-3 py-2 rounded-md font-medium disabled:opacity-50"
        :class="
          demoLogin
            ? 'border border-zinc-800 hover:bg-zinc-900'
            : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-50'
        "
      >
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>
