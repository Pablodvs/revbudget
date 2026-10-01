<script setup lang="ts">
import { onMounted, ref, useId, watch } from 'vue';

const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ close: [] }>();

// A native modal <dialog> brings focus trapping, Esc to close, an inert
// background and focus return to the opener without any extra code.
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();

watch(
  () => props.open,
  (open) => {
    const el = dialog.value;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  },
  // After render, so showModal() can focus the first field of the new content.
  { flush: 'post' },
);
// The watch only fires on changes, and `immediate` would run during setup,
// before the <dialog> exists; open a modal that mounts already open here.
onMounted(() => {
  if (props.open) dialog.value?.showModal();
});

// Clicks on the backdrop target the <dialog> itself (its content has the
// padding). Require the press to start there too, so dragging a text
// selection out of an input doesn't dismiss the form.
let pressedBackdrop = false;
function onPointerDown(e: PointerEvent) {
  pressedBackdrop = e.target === dialog.value;
}
function onClick(e: MouseEvent) {
  if (pressedBackdrop && e.target === dialog.value) emit('close');
}
</script>

<template>
  <dialog
    ref="dialog"
    :aria-labelledby="title ? titleId : undefined"
    class="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    @close="emit('close')"
    @pointerdown="onPointerDown"
    @click="onClick"
  >
    <div v-if="open" class="p-6">
      <h2 v-if="title" :id="titleId" class="mb-4 text-lg font-semibold">{{ title }}</h2>
      <slot />
    </div>
  </dialog>
</template>
