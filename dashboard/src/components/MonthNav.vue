<script setup lang="ts">
import { shiftMonth } from 'shared';

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
      class="h-8 w-8 grid place-items-center rounded-md border border-zinc-800 hover:bg-zinc-900"
      @click="prev"
    >
      ←
    </button>
    <div class="text-lg font-medium min-w-28 text-center tabular-nums">{{ modelValue }}</div>
    <button
      class="h-8 w-8 grid place-items-center rounded-md border border-zinc-800 hover:bg-zinc-900"
      @click="next"
    >
      →
    </button>
  </div>
</template>
