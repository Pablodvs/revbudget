<script setup lang="ts">
import { formatCents } from 'shared';
import type { Transaction } from 'shared';
import { computed, ref } from 'vue';
import Modal from '../components/Modal.vue';
import MonthNav from '../components/MonthNav.vue';
import { useTransactions, useUpdateTransaction } from '../composables/useTransactions';
import { useWallets } from '../composables/useWallets';
import { useFiltersStore } from '../stores/filters';

const filters = useFiltersStore();
const month = computed({
  get: () => filters.activeMonth,
  set: (v) => filters.setMonth(v),
});

const wallets = useWallets();
const txs = useTransactions(() => ({
  month: month.value,
  walletId: filters.txWalletId ?? undefined,
  status: filters.txStatus ?? undefined,
  limit: 500,
}));
const update = useUpdateTransaction();

const editing = ref<Transaction | null>(null);
const form = ref({ walletId: null as number | null, amount: 0, description: '' });

function openEdit(tx: Transaction) {
  editing.value = tx;
  form.value = {
    walletId: tx.walletId,
    amount: tx.amount,
    description: tx.description ?? '',
  };
}

async function save() {
  if (!editing.value) return;
  await update.mutateAsync({
    id: editing.value.id,
    patch: {
      walletId: form.value.walletId,
      amount: Number(form.value.amount),
      description: form.value.description || null,
    },
  });
  editing.value = null;
}

function walletName(id: number | null): string {
  if (id == null) return '—';
  return wallets.data.value?.find((w) => w.id === id)?.name ?? '—';
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
  }).format(new Date(iso));
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">Transactions</h1>
      <MonthNav v-model="month" />
    </div>

    <div class="flex flex-wrap gap-3 text-sm">
      <select
        v-model.number="filters.txWalletId"
        class="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
      >
        <option :value="null">All wallets</option>
        <option v-for="w in wallets.data.value ?? []" :key="w.id" :value="w.id">
          {{ w.icon }} {{ w.name }}
        </option>
      </select>
      <select
        v-model="filters.txStatus"
        class="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
      >
        <option :value="null">All statuses</option>
        <option value="pending">Pending</option>
        <option value="classified">Classified</option>
        <option value="ignored">Ignored</option>
      </select>
    </div>

    <div class="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900 text-zinc-400 text-left">
          <tr>
            <th class="px-4 py-2 font-medium">Date</th>
            <th class="px-4 py-2 font-medium">Merchant</th>
            <th class="px-4 py-2 font-medium">Wallet</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-900">
          <tr
            v-for="tx in txs.data.value ?? []"
            :key="tx.id"
            class="hover:bg-zinc-900/50 cursor-pointer"
            @click="openEdit(tx)"
          >
            <td class="px-4 py-3 text-zinc-500 whitespace-nowrap">{{ formatDate(tx.transactionDate) }}</td>
            <td class="px-4 py-3 font-medium">{{ tx.merchantDisplay }}</td>
            <td class="px-4 py-3 text-zinc-400">{{ walletName(tx.walletId) }}</td>
            <td class="px-4 py-3">
              <span
                v-if="tx.status === 'pending'"
                class="px-2 py-0.5 rounded bg-amber-400/10 text-amber-300 text-xs"
              >
                pending
              </span>
              <span
                v-else-if="tx.status === 'classified'"
                class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 text-xs"
              >
                classified
              </span>
              <span v-else class="px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 text-xs">
                ignored
              </span>
            </td>
            <td class="px-4 py-3 text-right tabular-nums font-semibold">
              {{ formatCents(tx.amount, tx.currency) }}
            </td>
          </tr>
          <tr v-if="!(txs.data.value ?? []).length">
            <td colspan="5" class="px-4 py-8 text-center text-zinc-500">No transactions</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal :open="!!editing" title="Edit transaction" @close="editing = null">
      <form class="space-y-4" @submit.prevent="save">
        <label class="block text-sm">
          <span class="text-zinc-400">Wallet</span>
          <select
            v-model.number="form.walletId"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          >
            <option :value="null">—</option>
            <option v-for="w in wallets.data.value ?? []" :key="w.id" :value="w.id">
              {{ w.icon }} {{ w.name }}
            </option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Amount (cents)</span>
          <input
            v-model.number="form.amount"
            type="number"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 tabular-nums"
          />
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Description</span>
          <input
            v-model="form.description"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
            @click="editing = null"
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
