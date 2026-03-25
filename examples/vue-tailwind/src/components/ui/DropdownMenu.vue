<template>
  <!-- Backdrop — captures outside clicks to close the menu -->
  <div v-if="isOpen" class="fixed inset-0 z-10" @click="onClose" aria-hidden="true" />

  <!-- Menu panel -->
  <div
    v-if="isOpen"
    ref="menuRef"
    :class="[
      'absolute left-0 top-full z-20 mt-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg',
      className,
    ]"
    role="menu"
    @keydown="handleKeyDown"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}>();

const menuRef = ref<HTMLDivElement | null>(null);

function getItems(): HTMLElement[] {
  return menuRef.value
    ? Array.from(menuRef.value.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
    : [];
}

const handleKeyDown = (e: KeyboardEvent) => {
  const items = getItems();
  if (items.length === 0) return;

  const current = items.indexOf(document.activeElement as HTMLElement);

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      items[(current + 1) % items.length]?.focus();
      break;
    case 'ArrowUp':
      e.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
      break;
    case 'Home':
      e.preventDefault();
      items[0]?.focus();
      break;
    case 'End':
      e.preventDefault();
      items[items.length - 1]?.focus();
      break;
    case 'Escape':
      e.preventDefault();
      props.onClose();
      break;
  }
};

// Auto-focus first menu item when menu opens
watch(
  () => props.isOpen,
  async (isOpen) => {
    if (isOpen) {
      await nextTick();
      getItems()[0]?.focus();
    }
  },
);
</script>
