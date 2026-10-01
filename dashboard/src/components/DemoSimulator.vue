<script setup lang="ts">
import { formatCents } from 'shared';
import type { DemoSample, IngestStatus } from 'shared';
import { ref, useId } from 'vue';
import { type SimulatedNotification, useSimulateNotification } from '../composables/useDemo';
import { useWallets } from '../composables/useWallets';

defineProps<{ samples: DemoSample[] }>();
// send fires as a send starts, created once its row exists.
const emit = defineEmits<{ send: []; created: [transactionId: number] }>();

const wallets = useWallets();
const simulate = useSimulateNotification();
const id = useId();
const text = ref('');
const outcome = ref<{ sent: string; text: string; tone: string } | null>(null);
const error = ref<string | null>(null);

const TONE: Record<IngestStatus, string> = {
  classified: 'border-emerald-500',
  pending_confirmation: 'border-sky-400',
  pending: 'border-amber-400',
  parse_failed: 'border-zinc-600',
};

function walletLabel(walletId: number | null | undefined): string {
  const w = wallets.data.value?.find((x) => x.id === walletId);
  return w ? `${w.icon ?? ''} ${w.name}`.trim() : 'a wallet';
}

// In plain words, what the Telegram bot would have said.
function describe(r: SimulatedNotification): string {
  const what = r.tx ? `${r.tx.merchantDisplay} · ${formatCents(r.tx.amount, r.tx.currency)}: ` : '';
  const walletId = r.tx?.walletId;
  const text: Record<IngestStatus, string> = {
    classified: `Auto-classified into ${walletLabel(walletId)} by a rule.`,
    pending_confirmation: `Waiting for your confirmation: a rule suggests ${walletLabel(walletId)}.`,
    pending: 'No rule matched. Pending: pick a wallet.',
    parse_failed:
      "Couldn't read this one. In production, the Telegram bot sends you the raw text to add by hand; here it's logged as a parse failure.",
  };
  return what + (text[r.status] ?? 'Received.');
}

async function send(body: string): Promise<boolean> {
  if (simulate.isPending.value) return false;
  outcome.value = null;
  error.value = null;
  emit('send');
  try {
    const r = await simulate.mutateAsync(body);
    outcome.value = { sent: body, text: describe(r), tone: TONE[r.status] ?? 'border-zinc-600' };
    if (r.transactionId != null) emit('created', r.transactionId);
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Couldn't send the notification.";
    return false;
  }
}

async function sendText() {
  const body = text.value.trim();
  if (body && (await send(body))) text.value = '';
}
</script>

<template>
  <section
    :aria-labelledby="`${id}-title`"
    class="rounded-xl border border-emerald-500/30 bg-zinc-950 p-5"
  >
    <div>
      <h2 :id="`${id}-title`" class="font-semibold">Simulate a Revolut notification</h2>
      <p class="mt-1 text-sm text-zinc-400">
        In production, an Android companion app forwards each Revolut notification and a Telegram bot asks
        what to do. Send one here and it runs through the same pipeline.
      </p>
    </div>

    <!-- The outcome quotes the exact text each sample sends. -->
    <div class="mt-4 flex flex-wrap gap-2">
      <button
        v-for="s in samples"
        :key="s.id"
        type="button"
        :disabled="simulate.isPending.value"
        class="px-3 py-1.5 rounded-full border border-zinc-800 bg-zinc-900 text-sm hover:border-zinc-600 disabled:opacity-50"
        @click="send(s.text)"
      >
        {{ s.label }}
      </button>
    </div>

    <form class="mt-4 flex flex-col sm:flex-row gap-2" @submit.prevent="sendText">
      <label :for="`${id}-text`" class="sr-only">Notification text</label>
      <textarea
        :id="`${id}-text`"
        v-model="text"
        rows="2"
        maxlength="500"
        placeholder="Or write your own…"
        class="flex-1 min-w-0 rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm focus:border-zinc-600 focus:outline-none"
      />
      <button
        type="submit"
        :disabled="simulate.isPending.value || !text.trim()"
        class="self-end sm:self-stretch px-4 py-2 rounded-md bg-emerald-500 text-zinc-950 text-sm font-medium hover:bg-emerald-400 disabled:opacity-50"
      >
        {{ simulate.isPending.value ? 'Sending…' : 'Send' }}
      </button>
    </form>

    <!-- Always rendered, so screen readers track it before the first result. -->
    <p role="status" class="text-sm">
      <span v-if="outcome" class="mt-4 block border-l-2 pl-3" :class="outcome.tone">
        <span class="block text-zinc-400 break-words">
          Sent: <span class="font-mono text-xs">“{{ outcome.sent }}”</span>
        </span>
        {{ outcome.text }}
      </span>
    </p>
    <p v-if="error" role="alert" class="mt-4 text-sm text-red-400">{{ error }}</p>
  </section>
</template>
