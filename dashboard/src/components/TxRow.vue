<script setup lang="ts">
import type { Transaction, Wallet } from 'shared';
import { formatCents } from 'shared';
import { computed } from 'vue';

const props = defineProps<{ tx: Transaction; wallets: Wallet[] }>();

const wallet = computed(() => props.wallets.find((w) => w.id === props.tx.walletId) ?? null);

const formattedDate = computed(() =>
  new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
  }).format(new Date(props.tx.transactionDate)),
);
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
        <div class="text-xs text-zinc-500 truncate">
          {{ formattedDate }}
          <span v-if="wallet" class="ml-1">· {{ wallet.name }}</span>
          <span
            v-if="tx.status === 'pending'"
            class="ml-2 px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-300 text-[10px]"
          >
            pending
          </span>
          <span
            v-else-if="tx.status === 'pending_confirmation'"
            class="ml-2 px-1.5 py-0.5 rounded bg-sky-400/10 text-sky-300 text-[10px]"
          >
            awaiting confirm
          </span>
          <span
            v-else-if="tx.status === 'ignored'"
            class="ml-2 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 text-[10px]"
          >
            ignored
          </span>
        </div>
      </div>
    </div>
    <div class="text-sm font-semibold tabular-nums whitespace-nowrap">
      {{ formatCents(tx.amount, tx.currency) }}
    </div>
  </div>
</template>
