<script setup lang="ts">
import type { Transaction, Wallet } from 'shared';
import { formatCents, formatDateTime } from 'shared';
import { computed } from 'vue';
import { STATUS_META } from '../lib/status';

const props = defineProps<{ tx: Transaction; wallets: Wallet[] }>();

const wallet = computed(() => props.wallets.find((w) => w.id === props.tx.walletId) ?? null);
</script>

<template>
  <div class="flex items-center justify-between gap-4 py-3">
    <div class="flex items-center gap-3 min-w-0">
      <div
        class="h-9 w-9 grid place-items-center rounded-lg"
        :style="{ backgroundColor: (wallet?.color ?? '#3f3f46') + '33' }"
      >
        <span class="text-lg">{{ wallet?.icon ?? '💳' }}</span>
      </div>
      <div class="min-w-0">
        <div class="font-medium truncate">{{ tx.merchantDisplay }}</div>
        <div class="text-xs text-zinc-400 truncate">
          {{ formatDateTime(tx.transactionDate) }}
          <span v-if="wallet" class="ml-1">· {{ wallet.name }}</span>
          <!-- Classified is the normal state, so only the exceptions get a badge. -->
          <span
            v-if="tx.status !== 'classified'"
            class="ml-2 px-1.5 py-0.5 rounded text-[10px]"
            :class="STATUS_META[tx.status].cls"
          >
            {{ STATUS_META[tx.status].label }}
          </span>
        </div>
      </div>
    </div>
    <div class="text-sm font-semibold tabular-nums whitespace-nowrap">
      {{ formatCents(tx.amount, tx.currency) }}
    </div>
  </div>
</template>
