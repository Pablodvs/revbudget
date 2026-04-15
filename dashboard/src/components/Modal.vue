<script setup lang="ts">
defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4"
      @click.self="emit('close')"
    >
      <div class="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        <div v-if="title" class="mb-4 text-lg font-semibold">{{ title }}</div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>
