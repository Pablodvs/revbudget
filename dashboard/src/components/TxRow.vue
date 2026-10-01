<script setup lang="ts">
import type { Transaction, Wallet } from 'shared';
import { formatCents, formatDateTime } from 'shared';
import { computed } from 'vue';
import { STATUS_META } from '../lib/status';
import TxActions from './TxActions.vue';

// editable: the row opens the edit dialog (the Transactions list on phones).
const props = defineProps<{ tx: Transaction; wallets: Wallet[]; editable?: boolean }>();
const emit = defineEmits<{ edit: [] }>();

const wallet = computed(() => props.wallets.find((w) => w.id === props.tx.walletId) ?? null);
// Money in is marked, as in the Transactions table.
const moneyIn = computed(() => props.tx.type === 'income' || props.tx.type === 'refund');
</script>

<template>
  <!-- As in the Transactions table: the merchant button is the keyboard and
       screen-reader control, the row click just a bigger target. -->
  <div
    class="flex items-center justify-between gap-4 py-3"
    :class="{ 'cursor-pointer': editable }"
    @click="editable && emit('edit')"
  >
    <div class="flex items-center gap-3 min-w-0">
      <div
        class="h-9 w-9 shrink-0 grid place-items-center rounded-lg"
        :style="{ backgroundColor: (wallet?.color ?? '#3f3f46') + '33' }"
      >
        <span class="text-lg">{{ wallet?.icon ?? '💳' }}</span>
      </div>
      <div class="min-w-0">
        <button
          v-if="editable"
          type="button"
          class="block max-w-full font-medium text-left truncate hover:underline"
          @click.stop="emit('edit')"
        >
          {{ tx.merchantDisplay }}
        </button>
        <div v-else class="font-medium truncate">{{ tx.merchantDisplay }}</div>
        <!-- Wraps, so a phone shows the whole status badge on its own line. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
          <span>
            {{ formatDateTime(tx.transactionDate) }}<template v-if="wallet"> · {{ wallet.name }}</template>
          </span>
          <!-- Classified is the normal state, so only the exceptions get a badge. -->
          <span
            v-if="tx.status !== 'classified'"
            class="px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap"
            :class="STATUS_META[tx.status].cls"
          >
            {{ STATUS_META[tx.status].label }}
          </span>
        </div>
        <TxActions :tx="tx" :wallets="wallets" class="mt-2" />
      </div>
    </div>
    <div
      class="text-sm font-semibold tabular-nums whitespace-nowrap"
      :class="{ 'text-emerald-300': moneyIn }"
    >
      {{ moneyIn ? '+' : '' }}{{ formatCents(tx.amount, tx.currency) }}
    </div>
  </div>
</template>
