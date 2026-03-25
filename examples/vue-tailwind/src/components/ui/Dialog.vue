<template>
  <div
    v-if="open"
    ref="overlayRef"
    class="fixed inset-0 z-50 bg-black/50 md:flex md:items-center md:justify-center"
    @click="handleBackdropClick"
  >
    <div
      ref="dialogRef"
      :class="[
        'relative flex h-full w-full flex-col bg-white md:h-auto md:w-[28rem] md:max-w-[90vw] md:rounded-lg md:border md:border-gray-200 md:shadow-lg',
        className,
      ]"
      :style="{ maxWidth }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="title ? titleId : undefined"
      tabindex="-1"
      @click.stop
      @keydown="handleFocusTrap"
    >
      <!-- Header -->
      <div
        v-if="title || showCloseButton"
        class="flex flex-shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4"
      >
        <h2 v-if="title" :id="titleId" class="text-lg font-semibold text-gray-900">{{ title }}</h2>
        <button
          v-if="showCloseButton"
          @click="onClose"
          class="rounded p-1 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Close dialog"
        >
          <CloseIcon class="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 space-y-6 overflow-y-auto px-6 py-4 md:max-h-[80vh] md:flex-none">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue';
import { CloseIcon } from '../icons';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    onClose?: () => void;
    className?: string;
    showCloseButton?: boolean;
    maxWidth?: string;
  }>(),
  {
    showCloseButton: true,
    maxWidth: '32rem',
  },
);

const overlayRef = ref<HTMLDivElement | null>(null);
const dialogRef = ref<HTMLDivElement | null>(null);

// Unique ID for aria-labelledby — one per component instance
let idSeed = 0;
const titleId = `dialog-title-${++idSeed}`;

// Element that had focus before the dialog opened — restored on close
let previousFocus: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

function getFocusable(): HTMLElement[] {
  if (!dialogRef.value) return [];

  // Build a robust focusable list: explicitly exclude tabindex=-1, hidden and disabled content.
  return Array.from(dialogRef.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if ((el as HTMLInputElement).disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute('inert')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  });
}

/** Trap Tab / Shift+Tab within the dialog */
const handleFocusTrap = (e: KeyboardEvent) => {
  if (e.key !== 'Tab') return;
  const items = getFocusable();
  if (items.length === 0) {
    // Keep focus on the dialog itself when there are no tabbable descendants.
    e.preventDefault();
    dialogRef.value?.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;

  // If focus escaped the dialog somehow, recover immediately.
  if (!active || !dialogRef.value?.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }

  if (e.shiftKey) {
    if (active === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }
};

const handleBackdropClick = (e: MouseEvent) => {
  if (e.target === overlayRef.value) props.onClose?.();
};

const handleEscape = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && props.open) props.onClose?.();
};

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      previousFocus = document.activeElement as HTMLElement | null;
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', handleEscape);
      // Move focus into the dialog after it has rendered
      await nextTick();
      const items = getFocusable();
      (items[0] ?? dialogRef.value)?.focus();
    } else {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleEscape);
      // Return focus to the element that triggered the dialog
      previousFocus?.focus();
      previousFocus = null;
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  document.body.style.overflow = '';
  document.removeEventListener('keydown', handleEscape);
});
</script>
