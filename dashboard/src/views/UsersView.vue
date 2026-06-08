<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authClient } from '../lib/auth';

type AdminUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  createdAt: string | Date;
};

const users = ref<AdminUser[]>([]);
const loading = ref(false);
const listError = ref<string | null>(null);

const newEmail = ref('');
const newPassword = ref('');
const newName = ref('');
const newRole = ref<'user' | 'admin'>('user');
const submitting = ref(false);
const formError = ref<string | null>(null);

async function refresh() {
  loading.value = true;
  listError.value = null;
  try {
    const res = await authClient.admin.listUsers({ query: { limit: 100 } });
    if (res.error) {
      listError.value = res.error.message ?? 'failed to list users';
      return;
    }
    users.value = (res.data?.users ?? []) as AdminUser[];
  } catch (err) {
    listError.value = err instanceof Error ? err.message : 'failed to list users';
  } finally {
    loading.value = false;
  }
}

async function add() {
  if (submitting.value) return;
  submitting.value = true;
  formError.value = null;
  try {
    const res = await authClient.admin.createUser({
      email: newEmail.value.trim(),
      password: newPassword.value,
      name: newName.value.trim() || newEmail.value.split('@')[0] || newEmail.value,
      role: newRole.value,
    });
    if (res.error) {
      formError.value = res.error.message ?? 'create failed';
      return;
    }
    newEmail.value = '';
    newPassword.value = '';
    newName.value = '';
    newRole.value = 'user';
    await refresh();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'create failed';
  } finally {
    submitting.value = false;
  }
}

async function remove(id: string, email: string) {
  if (!confirm(`Remove user ${email}?`)) return;
  const res = await authClient.admin.removeUser({ userId: id });
  if (res.error) {
    listError.value = res.error.message ?? 'remove failed';
    return;
  }
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight">Users</h1>
      <p class="text-sm text-zinc-400">Invite collaborators by creating an account for them.</p>
    </header>

    <section class="space-y-3 p-4 rounded-xl border border-zinc-800 bg-zinc-950">
      <h2 class="text-sm font-medium text-zinc-200">Add user</h2>
      <form class="grid gap-3 md:grid-cols-5 md:items-end" @submit.prevent="add">
        <label class="md:col-span-2 space-y-1">
          <span class="text-xs text-zinc-400">Email</span>
          <input
            v-model="newEmail"
            type="email"
            required
            class="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:border-zinc-600 focus:outline-none"
          />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-zinc-400">Password</span>
          <input
            v-model="newPassword"
            type="password"
            required
            minlength="12"
            class="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:border-zinc-600 focus:outline-none"
          />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-zinc-400">Name</span>
          <input
            v-model="newName"
            type="text"
            class="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:border-zinc-600 focus:outline-none"
          />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-zinc-400">Role</span>
          <select
            v-model="newRole"
            class="w-full px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:border-zinc-600 focus:outline-none"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <p v-if="formError" class="md:col-span-5 text-sm text-red-400">{{ formError }}</p>
        <button
          type="submit"
          :disabled="submitting"
          class="md:col-span-5 px-3 py-2 rounded-md bg-zinc-100 text-zinc-900 font-medium hover:bg-white disabled:opacity-50"
        >
          {{ submitting ? 'Adding…' : 'Add user' }}
        </button>
      </form>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-medium text-zinc-200">Existing users</h2>
      <p v-if="listError" class="text-sm text-red-400">{{ listError }}</p>
      <p v-if="loading" class="text-sm text-zinc-400">Loading…</p>
      <div v-else class="rounded-xl border border-zinc-800 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-zinc-900 text-zinc-400">
            <tr>
              <th class="text-left px-3 py-2">Email</th>
              <th class="text-left px-3 py-2">Name</th>
              <th class="text-left px-3 py-2">Role</th>
              <th class="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" class="border-t border-zinc-800">
              <td class="px-3 py-2">{{ u.email }}</td>
              <td class="px-3 py-2 text-zinc-400">{{ u.name }}</td>
              <td class="px-3 py-2 text-zinc-400">{{ u.role ?? 'user' }}</td>
              <td class="px-3 py-2 text-right">
                <button
                  class="text-xs text-red-400 hover:text-red-300"
                  @click="remove(u.id, u.email)"
                >
                  Remove
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
