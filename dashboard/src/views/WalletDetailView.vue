<script setup lang="ts">
import { formatCents, monthBounds } from 'shared';
import { computed, ref } from 'vue';
import Modal from '../components/Modal.vue';
import MonthNav from '../components/MonthNav.vue';
import ProgressBar from '../components/ProgressBar.vue';
import TxRow from '../components/TxRow.vue';
import { useTransactions } from '../composables/useTransactions';
import { useUpdateWallet, useWallet, useWallets } from '../composables/useWallets';
import { useFiltersStore } from '../stores/filters';

const props = defineProps<{ id: string }>();
const walletId = computed(() => Number(props.id));

const filters = useFiltersStore();
const month = computed({
  get: () => filters.activeMonth,
  set: (v) => filters.setMonth(v),
});

const wallet = useWallet(walletId.value);
const wallets = useWallets();
const txs = useTransactions(() => ({ month: month.value, walletId: walletId.value }));
const update = useUpdateWallet();

const spent = computed(() =>
  (txs.data.value ?? [])
    .filter((t) => t.status === 'classified')
    .reduce((acc, t) => acc + t.amount, 0),
);

const cumulative = computed(() => {
  const bounds = monthBounds(month.value);
  if (!bounds || !wallet.data.value) return { points: '', max: 1, days: 30 };
  const start = new Date(bounds.startISO).getTime();
  const end = new Date(bounds.endISO).getTime();
  const totalDays = Math.max(1, Math.round((end - start) / 86400000));
  const daily: number[] = new Array(totalDays + 1).fill(0);
  const sorted = (txs.data.value ?? [])
    .filter((t) => t.status === 'classified')
    .map((t) => ({ t: new Date(t.transactionDate).getTime(), a: t.amount }))
    .sort((x, y) => x.t - y.t);
  let running = 0;
  let idx = 0;
  for (let d = 0; d <= totalDays; d++) {
    const dayEnd = start + (d + 1) * 86400000;
    while (idx < sorted.length) {
      const entry = sorted[idx];
      if (!entry || entry.t >= dayEnd) break;
      running += entry.a;
      idx++;
    }
    daily[d] = running;
  }
  const max = Math.max(wallet.data.value.budget, running, 1);
  const points = daily
    .map((v, i) => {
      const x = (i / totalDays) * 100;
      const y = 100 - (v / max) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const budgetY = 100 - (wallet.data.value.budget / max) * 100;
  return { points, max, days: totalDays, budgetY };
});

const editOpen = ref(false);
const form = ref({ name: '', budget: 0, color: '#22c55e', icon: '' });

function openEdit() {
  if (!wallet.data.value) return;
  form.value = {
    name: wallet.data.value.name,
    budget: wallet.data.value.budget,
    color: wallet.data.value.color,
    icon: wallet.data.value.icon ?? '',
  };
  editOpen.value = true;
}

async function saveEdit() {
  await update.mutateAsync({
    id: walletId.value,
    patch: {
      name: form.value.name,
      budget: Number(form.value.budget),
      color: form.value.color,
      icon: form.value.icon || null,
    },
  });
  editOpen.value = false;
  wallet.refetch();
}
</script>

<template>
  <div class="space-y-8">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div v-if="wallet.data.value" class="flex items-center gap-4">
        <div
          class="h-12 w-12 grid place-items-center rounded-xl text-2xl"
          :style="{ backgroundColor: wallet.data.value.color + '33' }"
        >
          {{ wallet.data.value.icon ?? '💼' }}
        </div>
        <div>
          <h1 class="text-2xl font-semibold">{{ wallet.data.value.name }}</h1>
          <div class="text-sm text-zinc-500">
            {{ formatCents(wallet.data.value.budget, wallet.data.value.currency) }} budget
          </div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <MonthNav v-model="month" />
        <button
          class="text-sm px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
          @click="openEdit"
        >
          Edit
        </button>
      </div>
    </div>

    <section v-if="wallet.data.value" class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <div class="flex justify-between mb-3 text-sm">
        <span class="text-zinc-500">Spent</span>
        <span class="tabular-nums font-semibold">
          {{ formatCents(spent, wallet.data.value.currency) }}
          <span class="text-zinc-500 font-normal">/
            {{ formatCents(wallet.data.value.budget, wallet.data.value.currency) }}</span>
        </span>
      </div>
      <ProgressBar :spent="spent" :budget="wallet.data.value.budget" />
    </section>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        Cumulative spending
      </h2>
      <svg viewBox="0 0 100 100" class="w-full h-48" preserveAspectRatio="none">
        <line
          x1="0"
          :y1="cumulative.budgetY ?? 0"
          x2="100"
          :y2="cumulative.budgetY ?? 0"
          stroke="#f43f5e"
          stroke-width="0.3"
          stroke-dasharray="1,1"
        />
        <polyline
          :points="cumulative.points"
          fill="none"
          :stroke="wallet.data.value?.color ?? '#22c55e'"
          stroke-width="0.8"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    </section>

    <section>
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">Transactions</h2>
      <div class="rounded-xl border border-zinc-800 bg-zinc-950 px-5 divide-y divide-zinc-900">
        <TxRow
          v-for="tx in txs.data.value ?? []"
          :key="tx.id"
          :tx="tx"
          :wallets="wallets.data.value ?? []"
        />
        <div v-if="!(txs.data.value ?? []).length" class="py-8 text-center text-zinc-500 text-sm">
          No transactions
        </div>
      </div>
    </section>

    <Modal :open="editOpen" title="Edit wallet" @close="editOpen = false">
      <form class="space-y-4" @submit.prevent="saveEdit">
        <label class="block text-sm">
          <span class="text-zinc-400">Name</span>
          <input
            v-model="form.name"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Budget (cents)</span>
          <input
            v-model.number="form.budget"
            type="number"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 tabular-nums"
          />
        </label>
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
              class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
            />
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
            @click="editOpen = false"
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
