<script setup lang="ts">
import { type Wallet, formatCents } from 'shared';
import { ref } from 'vue';
import Modal from '../components/Modal.vue';
import {
  useCreateWallet,
  useDeleteWallet,
  useUpdateWallet,
  useWallets,
} from '../composables/useWallets';

const wallets = useWallets();
const create = useCreateWallet();
const update = useUpdateWallet();
const remove = useDeleteWallet();

const modalOpen = ref(false);
const editing = ref<Wallet | null>(null);
const submitting = ref(false);
const formError = ref<string | null>(null);
const listError = ref<string | null>(null);
const form = ref({
  name: '',
  budget: 0,
  currency: 'EUR',
  color: '#22c55e',
  icon: '',
  isActive: true,
});

function openNew() {
  editing.value = null;
  formError.value = null;
  form.value = {
    name: '',
    budget: 0,
    currency: 'EUR',
    color: '#22c55e',
    icon: '',
    isActive: true,
  };
  modalOpen.value = true;
}

function openEdit(w: Wallet) {
  editing.value = w;
  formError.value = null;
  form.value = {
    name: w.name,
    budget: w.budget,
    currency: w.currency,
    color: w.color,
    icon: w.icon ?? '',
    isActive: w.isActive,
  };
  modalOpen.value = true;
}

async function save() {
  if (submitting.value) return;
  submitting.value = true;
  formError.value = null;
  const payload = {
    name: form.value.name,
    budget: Number(form.value.budget),
    currency: form.value.currency,
    color: form.value.color,
    icon: form.value.icon || null,
    isActive: form.value.isActive,
  };
  try {
    if (editing.value) {
      await update.mutateAsync({ id: editing.value.id, patch: payload });
    } else {
      await create.mutateAsync(payload);
    }
    modalOpen.value = false;
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'save failed';
  } finally {
    submitting.value = false;
  }
}

async function confirmDelete(w: Wallet) {
  const ok = window.confirm(
    `Delete wallet "${w.name}"? Its merchant rules will be removed and its transactions will be unassigned.`,
  );
  if (!ok) return;
  listError.value = null;
  try {
    await remove.mutateAsync(w.id);
  } catch (err) {
    listError.value = err instanceof Error ? err.message : 'delete failed';
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold tracking-tight">Wallets</h1>
      <button
        class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400"
        @click="openNew"
      >
        + New wallet
      </button>
    </div>

    <div class="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900 text-zinc-400 text-left">
          <tr>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Budget</th>
            <th class="px-4 py-2 font-medium">Color</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-900">
          <tr v-for="w in wallets.data.value ?? []" :key="w.id" class="hover:bg-zinc-900/50">
            <td class="px-4 py-3 font-medium">
              <span v-if="w.icon" class="mr-2">{{ w.icon }}</span>{{ w.name }}
            </td>
            <td class="px-4 py-3 text-zinc-400 tabular-nums">
              {{ formatCents(w.budget, w.currency) }}
            </td>
            <td class="px-4 py-3">
              <span
                class="inline-block h-4 w-4 rounded-full border border-zinc-800 align-middle"
                :style="{ backgroundColor: w.color }"
              />
              <span class="ml-2 text-zinc-500 text-xs tabular-nums">{{ w.color }}</span>
            </td>
            <td class="px-4 py-3">
              <span
                v-if="w.isActive"
                class="text-xs px-2 py-0.5 rounded border border-emerald-900/40 text-emerald-400"
              >
                Active
              </span>
              <span
                v-else
                class="text-xs px-2 py-0.5 rounded border border-zinc-800 text-zinc-500"
              >
                Archived
              </span>
            </td>
            <td class="px-4 py-3 text-right">
              <button
                class="text-xs px-2 py-1 rounded border border-zinc-800 hover:bg-zinc-900 mr-2"
                @click="openEdit(w)"
              >
                Edit
              </button>
              <button
                class="text-xs px-2 py-1 rounded border border-rose-900/40 text-rose-400 hover:bg-rose-950/30"
                @click="confirmDelete(w)"
              >
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="!(wallets.data.value ?? []).length">
            <td colspan="5" class="px-4 py-8 text-center text-zinc-500">No wallets yet</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="listError" class="text-sm text-red-400">{{ listError }}</p>

    <Modal
      :open="modalOpen"
      :title="editing ? 'Edit wallet' : 'New wallet'"
      @close="modalOpen = false"
    >
      <form class="space-y-4" @submit.prevent="save">
        <label class="block text-sm">
          <span class="text-zinc-400">Name</span>
          <input
            v-model="form.name"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block text-sm">
            <span class="text-zinc-400">Budget (cents)</span>
            <input
              v-model.number="form.budget"
              type="number"
              min="0"
              class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 tabular-nums"
            />
          </label>
          <label class="block text-sm">
            <span class="text-zinc-400">Currency</span>
            <input
              v-model="form.currency"
              maxlength="3"
              pattern="[A-Za-z]{3}"
              title="3-letter currency code, e.g. EUR"
              class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 uppercase"
            />
          </label>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="block text-sm">
            <span class="text-zinc-400">Color</span>
            <input
              v-model="form.color"
              type="color"
              class="mt-1 h-10 w-full rounded-md bg-zinc-900 border border-zinc-800"
            />
          </label>
          <label class="block text-sm">
            <span class="text-zinc-400">Icon</span>
            <input
              v-model="form.icon"
              maxlength="8"
              class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
            />
          </label>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="form.isActive" type="checkbox" class="rounded border-zinc-800" />
          <span class="text-zinc-400">Active</span>
        </label>
        <p v-if="formError" class="text-sm text-red-400">{{ formError }}</p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
            @click="modalOpen = false"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="submitting"
            class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  </div>
</template>
