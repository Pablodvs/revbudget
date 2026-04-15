<script setup lang="ts">
import { formatCents } from 'shared';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import MonthNav from '../components/MonthNav.vue';
import ProgressBar from '../components/ProgressBar.vue';
import TxRow from '../components/TxRow.vue';
import { useMonthlyStats } from '../composables/useStats';
import { useTransactions } from '../composables/useTransactions';
import { useWallets } from '../composables/useWallets';
import { useFiltersStore } from '../stores/filters';

const filters = useFiltersStore();
const month = computed({
  get: () => filters.activeMonth,
  set: (v) => filters.setMonth(v),
});

const wallets = useWallets();
const stats = useMonthlyStats(month);
const recent = useTransactions(() => ({ limit: 5, month: month.value }));
</script>

<template>
  <div class="space-y-8">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">Overview</h1>
      <MonthNav v-model="month" />
    </div>

    <section
      class="rounded-xl border border-zinc-800 bg-zinc-950 p-6 flex items-end justify-between gap-6"
    >
      <div>
        <div class="text-sm text-zinc-500">Spent this month</div>
        <div class="mt-1 text-3xl font-semibold tabular-nums">
          {{ stats.data.value ? formatCents(stats.data.value.totalSpent, 'EUR') : '—' }}
        </div>
        <div class="mt-1 text-sm text-zinc-500">
          of {{ stats.data.value ? formatCents(stats.data.value.totalBudget, 'EUR') : '—' }} budget
          · {{ stats.data.value?.transactionCount ?? 0 }} transactions
        </div>
      </div>
      <div class="w-72">
        <ProgressBar
          :spent="stats.data.value?.totalSpent ?? 0"
          :budget="stats.data.value?.totalBudget ?? 1"
        />
      </div>
    </section>

    <section>
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">Wallets</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <RouterLink
          v-for="w in stats.data.value?.perWallet ?? []"
          :key="w.walletId"
          :to="`/wallet/${w.walletId}`"
          class="rounded-xl border border-zinc-800 bg-zinc-950 p-5 hover:border-zinc-700 transition-colors"
        >
          <div class="flex items-center gap-3 mb-4">
            <div
              class="h-10 w-10 grid place-items-center rounded-lg text-lg"
              :style="{ backgroundColor: w.color + '33' }"
            >
              {{ w.icon ?? '💼' }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-semibold truncate">{{ w.walletName }}</div>
              <div class="text-xs text-zinc-500">{{ w.transactionCount }} tx</div>
            </div>
          </div>
          <ProgressBar :spent="w.spent" :budget="w.budget" />
          <div class="mt-3 flex justify-between text-sm tabular-nums">
            <span class="font-medium">{{ formatCents(w.spent, 'EUR') }}</span>
            <span class="text-zinc-500">{{ formatCents(w.budget, 'EUR') }}</span>
          </div>
        </RouterLink>
      </div>
    </section>

    <section>
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        Latest transactions
      </h2>
      <div class="rounded-xl border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900 px-5">
        <TxRow
          v-for="tx in recent.data.value ?? []"
          :key="tx.id"
          :tx="tx"
          :wallets="wallets.data.value ?? []"
        />
        <div v-if="!(recent.data.value ?? []).length" class="py-8 text-center text-zinc-500 text-sm">
          No transactions yet
        </div>
      </div>
    </section>
  </div>
</template>
