import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { IngestStatus, Transaction } from 'shared';
import { api, apiError } from '../lib/api';

type DemoNotificationResult = { ok: true; status: IngestStatus; transactionId: number | null };
export type SimulatedNotification = DemoNotificationResult & { tx: Transaction | null };

async function fetchTransaction(id: number): Promise<Transaction | null> {
  const res = await api.api.transactions[':id']
    .$get({ param: { id: String(id) } })
    .catch(() => null);
  return res?.ok ? ((await res.json()) as Transaction) : null;
}

// Runs text through the same pipeline as the Android app's webhook (demo only).
// The response only carries the new row's id, so the row is fetched as well,
// to say where it went.
export function useSimulateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string): Promise<SimulatedNotification> => {
      const res = await api.api.demo.notifications.$post({ json: { text } });
      if (!res.ok) throw await apiError(res, "Couldn't send the notification.");
      const result = (await res.json()) as DemoNotificationResult;
      const tx = result.transactionId == null ? null : await fetchTransaction(result.transactionId);
      return { ...result, tx };
    },
    // Returned, so mutateAsync resolves only once the lists hold the new row.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['transactions'] }),
        qc.invalidateQueries({ queryKey: ['stats'] }),
      ]),
  });
}
