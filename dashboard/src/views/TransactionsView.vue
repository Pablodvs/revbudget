<script setup lang="ts">
import { DEFAULT_TIMEZONE, formatCents } from 'shared';
import type { Transaction, TransactionType } from 'shared';
import { computed, ref } from 'vue';
import Modal from '../components/Modal.vue';
import MonthNav from '../components/MonthNav.vue';
import {
  useCreateTransaction,
  useTransactions,
  useUpdateTransaction,
} from '../composables/useTransactions';
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
const create = useCreateTransaction();

const editing = ref<Transaction | null>(null);
const form = ref({
  walletId: null as number | null,
  amount: 0,
  description: '',
  type: 'expense' as TransactionType,
  relatedTxId: null as number | null,
});

// datetime-local expects local wall-clock time; a bare toISOString() prefilled
// UTC, off by the timezone offset.
function nowForDatetimeLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const creating = ref(false);
const createForm = ref({
  walletId: null as number | null,
  amount: 0,
  merchantDisplay: '',
  description: '',
  type: 'expense' as TransactionType,
  transactionDate: nowForDatetimeLocal(),
  relatedTxId: null as number | null,
});

const submitting = ref(false);
const formError = ref<string | null>(null);

const TYPE_META: Record<TransactionType, { label: string; cls: string; sign: '+' | '-' | '' }> = {
  expense: { label: 'expense', cls: 'bg-zinc-800 text-zinc-300', sign: '-' },
  income: { label: 'income', cls: 'bg-emerald-500/10 text-emerald-300', sign: '+' },
  refund: { label: 'refund', cls: 'bg-sky-500/10 text-sky-300', sign: '+' },
  adjustment: { label: 'adjustment', cls: 'bg-amber-500/10 text-amber-300', sign: '-' },
};

function openEdit(tx: Transaction) {
  editing.value = tx;
  formError.value = null;
  form.value = {
    walletId: tx.walletId,
    amount: tx.amount,
    description: tx.description ?? '',
    type: tx.type,
    relatedTxId: tx.relatedTxId,
  };
}

async function save() {
  if (!editing.value || submitting.value) return;
  submitting.value = true;
  formError.value = null;
  try {
    await update.mutateAsync({
      id: editing.value.id,
      patch: {
        walletId: form.value.walletId,
        amount: Number(form.value.amount),
        description: form.value.description || null,
        type: form.value.type,
        relatedTxId:
          form.value.type === 'expense' || form.value.type === 'income'
            ? null
            : form.value.relatedTxId,
      },
    });
    editing.value = null;
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'update failed';
  } finally {
    submitting.value = false;
  }
}

function openCreate() {
  createForm.value = {
    walletId: wallets.data.value?.[0]?.id ?? null,
    amount: 0,
    merchantDisplay: '',
    description: '',
    type: 'expense',
    transactionDate: nowForDatetimeLocal(),
    relatedTxId: null,
  };
  formError.value = null;
  creating.value = true;
}

async function submitCreate() {
  const f = createForm.value;
  if (f.walletId == null || !f.merchantDisplay || f.amount <= 0) return;
  if (submitting.value) return;
  submitting.value = true;
  formError.value = null;
  try {
    await create.mutateAsync({
      walletId: f.walletId,
      amount: Number(f.amount),
      type: f.type,
      merchantDisplay: f.merchantDisplay,
      description: f.description || null,
      transactionDate: new Date(f.transactionDate).toISOString(),
      relatedTxId: f.type === 'refund' || f.type === 'adjustment' ? f.relatedTxId : null,
    });
    creating.value = false;
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'create failed';
  } finally {
    submitting.value = false;
  }
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
    timeZone: DEFAULT_TIMEZONE,
  }).format(new Date(iso));
}

function signedAmount(tx: Transaction): string {
  const meta = TYPE_META[tx.type];
  const formatted = formatCents(tx.amount, tx.currency);
  return meta.sign ? `${meta.sign}${formatted}` : formatted;
}

function amountClass(tx: Transaction): string {
  if (tx.type === 'income' || tx.type === 'refund') return 'text-emerald-300';
  return 'text-zinc-100';
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">Transactions</h1>
      <div class="flex items-center gap-3">
        <MonthNav v-model="month" />
        <button
          class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 text-sm font-medium hover:bg-emerald-400"
          @click="openCreate"
        >
          + New
        </button>
      </div>
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
        <option value="pending_confirmation">Awaiting confirm</option>
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
            <th class="px-4 py-2 font-medium">Type</th>
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
            <td class="px-4 py-3">
              <span class="px-2 py-0.5 rounded text-xs" :class="TYPE_META[tx.type].cls">
                {{ TYPE_META[tx.type].label }}
              </span>
            </td>
            <td class="px-4 py-3 text-zinc-400">{{ walletName(tx.walletId) }}</td>
            <td class="px-4 py-3">
              <span
                v-if="tx.status === 'pending'"
                class="px-2 py-0.5 rounded bg-amber-400/10 text-amber-300 text-xs"
              >
                pending
              </span>
              <span
                v-else-if="tx.status === 'pending_confirmation'"
                class="px-2 py-0.5 rounded bg-sky-400/10 text-sky-300 text-xs"
              >
                awaiting confirm
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
            <td
              class="px-4 py-3 text-right tabular-nums font-semibold"
              :class="amountClass(tx)"
            >
              {{ signedAmount(tx) }}
            </td>
          </tr>
          <tr v-if="!(txs.data.value ?? []).length">
            <td colspan="6" class="px-4 py-8 text-center text-zinc-500">No transactions</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal :open="!!editing" title="Edit transaction" @close="editing = null">
      <form class="space-y-4" @submit.prevent="save">
        <label class="block text-sm">
          <span class="text-zinc-400">Type</span>
          <select
            v-model="form.type"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="refund">Refund</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </label>
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
        <label
          v-if="form.type === 'refund' || form.type === 'adjustment'"
          class="block text-sm"
        >
          <span class="text-zinc-400">Related transaction ID (optional)</span>
          <input
            v-model.number="form.relatedTxId"
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
        <p v-if="formError" class="text-sm text-red-400">{{ formError }}</p>
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
            :disabled="submitting"
            class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>

    <Modal :open="creating" title="New transaction" @close="creating = false">
      <form class="space-y-4" @submit.prevent="submitCreate">
        <label class="block text-sm">
          <span class="text-zinc-400">Type</span>
          <select
            v-model="createForm.type"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="refund">Refund</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Wallet</span>
          <select
            v-model.number="createForm.walletId"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          >
            <option :value="null">—</option>
            <option v-for="w in wallets.data.value ?? []" :key="w.id" :value="w.id">
              {{ w.icon }} {{ w.name }}
            </option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Merchant / source</span>
          <input
            v-model="createForm.merchantDisplay"
            required
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Amount (cents)</span>
          <input
            v-model.number="createForm.amount"
            type="number"
            min="1"
            required
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 tabular-nums"
          />
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Date</span>
          <input
            v-model="createForm.transactionDate"
            type="datetime-local"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <label
          v-if="createForm.type === 'refund' || createForm.type === 'adjustment'"
          class="block text-sm"
        >
          <span class="text-zinc-400">Related transaction ID (optional)</span>
          <input
            v-model.number="createForm.relatedTxId"
            type="number"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 tabular-nums"
          />
        </label>
        <label class="block text-sm">
          <span class="text-zinc-400">Description</span>
          <input
            v-model="createForm.description"
            class="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2"
          />
        </label>
        <p v-if="formError" class="text-sm text-red-400">{{ formError }}</p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900"
            @click="creating = false"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="submitting"
            class="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 font-medium hover:bg-emerald-400 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </Modal>
  </div>
</template>
