<script setup lang="ts">
import type { MerchantRule } from 'shared';
import { ref } from 'vue';
import Modal from '../components/Modal.vue';
import { useCreateRule, useDeleteRule, useRules, useUpdateRule } from '../composables/useRules';
import { useWallets } from '../composables/useWallets';

const rules = useRules();
const wallets = useWallets();
const create = useCreateRule();
const update = useUpdateRule();
const remove = useDeleteRule();

const modalOpen = ref(false);
const editing = ref<MerchantRule | null>(null);
const form = ref({ pattern: '', walletId: 0, matchType: 'exact' as 'exact' | 'contains' });

function openNew() {
  editing.value = null;
  form.value = { pattern: '', walletId: wallets.data.value?.[0]?.id ?? 0, matchType: 'exact' };
  modalOpen.value = true;
}
function openEdit(r: MerchantRule) {
  editing.value = r;
  form.value = { pattern: r.pattern, walletId: r.walletId, matchType: r.matchType };
  modalOpen.value = true;
}
async function save() {
  if (!form.value.walletId) return;
  if (editing.value) {
    await update.mutateAsync({
      id: editing.value.id,
      patch: {
        pattern: form.value.pattern,
        walletId: form.value.walletId,
        matchType: form.value.matchType,
      },
    });
  } else {
    await create.mutateAsync({
      pattern: form.value.pattern,
      walletId: form.value.walletId,
      matchType: form.value.matchType,
    });
  }
  modalOpen.value = false;
}

function walletName(id: number): string {
  return wallets.data.value?.find((w) => w.id === id)?.name ?? '—';
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold tracking-tight">Merchant rules</h1>
      <button
        class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400"
        @click="openNew"
      >
        + New rule
      </button>
    </div>

    <div class="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900 text-zinc-400 text-left">
          <tr>
            <th class="px-4 py-2 font-medium">Pattern</th>
            <th class="px-4 py-2 font-medium">Match</th>
            <th class="px-4 py-2 font-medium">Wallet</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-900">
          <tr v-for="r in rules.data.value ?? []" :key="r.id" class="hover:bg-zinc-900/50">
            <td class="px-4 py-3 font-medium">{{ r.pattern }}</td>
            <td class="px-4 py-3 text-zinc-400">{{ r.matchType }}</td>
            <td class="px-4 py-3 text-zinc-400">{{ walletName(r.walletId) }}</td>
            <td class="px-4 py-3 text-right">
              <button
                class="text-xs px-2 py-1 rounded border border-zinc-800 hover:bg-zinc-900 mr-2"
                @click="openEdit(r)"
              >
                Edit
              </button>
              <button
                class="text-xs px-2 py-1 rounded border border-rose-900/40 text-rose-400 hover:bg-rose-950/30"
                @click="remove.mutate(r.id)"
              >
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="!(rules.data.value ?? []).length">
            <td colspan="4" class="px-4 py-8 text-center text-zinc-500">No rules yet</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal :open="modalOpen" :title="editing ? 'Edit rule' : 'New rule'" @close="modalOpen = false">
      <form class="space-y-4" @submit.prevent="save">
        <label class="block text-sm">
          <span class="text-zinc-400">Pattern (normalized)</span>
          <input
            v-model="form.pattern"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Match type</span>
          <select
            v-model="form.matchType"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          >
            <option value="exact">exact</option>
            <option value="contains">contains</option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Wallet</span>
          <select
            v-model.number="form.walletId"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          >
            <option v-for="w in wallets.data.value ?? []" :key="w.id" :value="w.id">
              {{ w.icon }} {{ w.name }}
            </option>
          </select>
        </label>
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
            class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  </div>
</template>
