<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { authClient } from '../lib/auth';

const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const res = await authClient.signIn.email({
      email: email.value.trim(),
      password: password.value,
    });
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
</script>

<template>
  <div class="min-h-[80vh] flex items-center justify-center">
    <form
      class="w-full max-w-sm space-y-4 p-6 rounded-xl border border-zinc-800 bg-zinc-950"
      @submit.prevent="submit"
    >
      <h1 class="text-xl font-semibold tracking-tight">💰 RevBudget — sign in</h1>
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
      <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
      <button
        type="submit"
        :disabled="submitting"
        class="w-full px-3 py-2 rounded-md bg-zinc-100 text-zinc-900 font-medium hover:bg-white disabled:opacity-50"
      >
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>
