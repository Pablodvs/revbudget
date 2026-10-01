<script setup lang="ts">
import { formatMonth, shiftMonth } from 'shared';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function prev() {
  emit('update:modelValue', shiftMonth(props.modelValue, -1));
}
function next() {
  emit('update:modelValue', shiftMonth(props.modelValue, 1));
}
</script>

<template>
  <div class="flex items-center gap-3">
    <button
      type="button"
      aria-label="Previous month"
      class="h-8 w-8 grid place-items-center rounded-md border border-zinc-800 hover:bg-zinc-900"
      @click="prev"
    >
      ←
    </button>
    <div class="text-lg font-medium min-w-40 text-center" aria-live="polite">
      {{ formatMonth(modelValue) }}
    </div>
    <button
      type="button"
      aria-label="Next month"
      class="h-8 w-8 grid place-items-center rounded-md border border-zinc-800 hover:bg-zinc-900"
      @click="next"
    >
      →
    </button>
  </div>
</template>
