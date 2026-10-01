<script setup lang="ts">
// Fills the spot where a list says "No X yet", but tells the three cases apart:
// still loading, failed (with a retry), or genuinely empty. A failed query must
// never look like an empty one.
defineProps<{
  query: { isPending: { value: boolean }; isError: { value: boolean }; refetch: () => unknown };
  empty: string;
}>();
</script>

<template>
  <span v-if="query.isPending.value" class="text-zinc-400">Loading…</span>
  <span v-else-if="query.isError.value" class="text-red-400">
    Couldn't load this.
    <button type="button" class="ml-1 underline hover:text-zinc-100" @click="query.refetch()">
      Retry
    </button>
  </span>
  <span v-else class="text-zinc-400">{{ empty }}</span>
</template>
