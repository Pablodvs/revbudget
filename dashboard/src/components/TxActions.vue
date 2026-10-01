<script setup lang="ts">
import type { Transaction, TransactionUpdate, Wallet } from 'shared';
import { formatCents } from 'shared';
import { computed, ref } from 'vue';
import { useUpdateTransaction } from '../composables/useTransactions';
import Modal from './Modal.vue';

// One-click review for rows still waiting on a decision, offering what the
// Telegram prompt does: classify into a wallet, confirm or change the wallet a
// rule suggested, or ignore. Renders nothing for settled rows, except the note
// that a classification taught a rule.
const props = defineProps<{ tx: Transaction; wallets: Wallet[] }>();

const update = useUpdateTransaction();
const picking = ref(false);
const error = ref<string | null>(null);
const learned = ref<string | null>(null);

const needsReview = computed(
  () => props.tx.status === 'pending' || props.tx.status === 'pending_confirmation',
);
const suggested = computed(() =>
  props.tx.status === 'pending_confirmation'
    ? (props.wallets.find((w) => w.id === props.tx.walletId) ?? null)
    : null,
);
const choices = computed(() => props.wallets.filter((w) => w.isActive));
// As on the server: classifying a pending expense teaches an exact rule for its
// merchant; confirming or changing a rule's suggestion doesn't.
const teaches = computed(
  () => props.tx.status === 'pending' && props.tx.type === 'expense' && props.tx.merchant !== '',
);

function openPicker() {
  error.value = null;
  picking.value = true;
}

async function apply(patch: TransactionUpdate) {
  if (update.isPending.value) return;
  error.value = null;
  // Read before the update: the refetched row is no longer pending.
  const teaching = teaches.value && patch.walletId != null;
  try {
    await update.mutateAsync({ id: props.tx.id, patch });
    picking.value = false;
    if (teaching) {
      const wallet = props.wallets.find((w) => w.id === patch.walletId);
      learned.value = `Learned: ${props.tx.merchantDisplay} → ${wallet?.name ?? 'that wallet'}. The next one from this merchant is classified automatically.`;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'update failed';
  }
}
</script>

<template>
  <!-- click.stop: rows open the edit dialog on click, and clicks inside the
       picker dialog bubble through here too. -->
  <div v-if="needsReview || learned" class="flex flex-wrap items-center gap-1.5" @click.stop>
    <template v-if="needsReview">
      <button
        v-if="suggested"
        type="button"
        :aria-label="`Confirm ${suggested.name} for ${tx.merchantDisplay}`"
        :disabled="update.isPending.value"
        class="px-2 py-1 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 whitespace-nowrap"
        @click="apply({ walletId: suggested.id })"
      >
        Confirm <span aria-hidden="true">→ {{ suggested.icon }}</span> {{ suggested.name }}
      </button>
      <button
        type="button"
        aria-haspopup="dialog"
        :aria-label="
          suggested ? `Change wallet for ${tx.merchantDisplay}` : `Classify ${tx.merchantDisplay}`
        "
        :disabled="update.isPending.value"
        class="px-2 py-1 rounded-md text-xs border border-zinc-800 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-50 whitespace-nowrap"
        :class="suggested ? '' : 'font-medium'"
        @click="openPicker"
      >
        <template v-if="suggested">Change</template>
        <template v-else>Classify <span aria-hidden="true">▾</span></template>
      </button>
      <!-- On phones this lives in the picker, to keep the row compact. -->
      <button
        type="button"
        :aria-label="`Ignore ${tx.merchantDisplay}`"
        :disabled="update.isPending.value"
        class="hidden sm:inline-block px-2 py-1 rounded-md text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-50"
        @click="apply({ status: 'ignored' })"
      >
        Ignore
      </button>
    </template>
    <p v-if="learned" role="status" class="basis-full max-w-xs text-xs text-emerald-300">{{ learned }}</p>
    <p v-if="error && !picking" role="alert" class="basis-full text-xs text-red-400">
      {{ error }}
    </p>

    <Modal
      :open="picking"
      :title="suggested ? `Choose a wallet for ${tx.merchantDisplay}` : `Classify ${tx.merchantDisplay}`"
      @close="picking = false"
    >
      <div class="-mt-2 mb-4 text-sm text-zinc-400">
        <p>
          {{ formatCents(tx.amount, tx.currency) }}
          <template v-if="suggested">· a rule suggested {{ suggested.name }}</template>
        </p>
        <p v-if="teaches" class="mt-1">Classifying teaches a rule for this merchant.</p>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="w in choices"
          :key="w.id"
          type="button"
          :disabled="update.isPending.value"
          class="flex items-center gap-1.5 min-w-0 rounded-lg border px-2.5 py-2 text-sm text-left hover:bg-zinc-900 disabled:opacity-50"
          :class="w.id === suggested?.id ? 'border-emerald-500/50' : 'border-zinc-800'"
          @click="apply({ walletId: w.id })"
        >
          <span
            class="h-7 w-7 shrink-0 grid place-items-center rounded-md"
            :style="{ backgroundColor: w.color + '33' }"
            aria-hidden="true"
          >
            {{ w.icon ?? '💼' }}
          </span>
          <!-- Wraps rather than truncates: two columns are tight on a phone. -->
          <span class="min-w-0 break-words hyphens-auto">{{ w.name }}</span>
        </button>
      </div>
      <p v-if="!choices.length" class="text-sm text-zinc-400">No active wallets.</p>
      <p v-if="error" role="alert" class="mt-3 text-sm text-red-400">{{ error }}</p>
      <div class="flex justify-between gap-2 pt-4">
        <button
          type="button"
          :disabled="update.isPending.value"
          class="px-3 py-1.5 rounded-md border border-zinc-800 text-sm hover:bg-zinc-900 disabled:opacity-50"
          @click="apply({ status: 'ignored' })"
        >
          Ignore
        </button>
        <button
          type="button"
          class="px-3 py-1.5 rounded-md border border-zinc-800 text-sm hover:bg-zinc-900"
          @click="picking = false"
        >
          Cancel
        </button>
      </div>
    </Modal>
  </div>
</template>
