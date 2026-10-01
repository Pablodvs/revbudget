<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ spent: number; budget: number }>();

const pct = computed(() => {
  if (props.budget <= 0) return 0;
  // Refunds can leave a month's spend negative; width:-x% is invalid CSS and
  // would render a full bar.
  return Math.min(100, Math.max(0, Math.round((props.spent / props.budget) * 100)));
});

const colorClass = computed(() => {
  if (pct.value < 70) return 'bg-emerald-500';
  if (pct.value < 90) return 'bg-amber-400';
  return 'bg-rose-500';
});
</script>

<template>
  <div class="w-full">
    <div class="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
      <div
        class="h-full transition-all duration-500"
        :class="colorClass"
        :style="{ width: pct + '%' }"
      />
    </div>
  </div>
</template>
