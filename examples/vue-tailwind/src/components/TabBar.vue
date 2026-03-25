<template>
  <div class="flex items-end gap-0.5 bg-gray-100 px-2 pt-2">
    <!-- Document Tabs -->
    <div
      class="flex flex-1 items-end gap-0.5 overflow-x-auto"
      ref="tablistRef"
      role="tablist"
      aria-label="Open documents"
    >
      <div
        v-for="document in documentStates"
        :key="document.id"
        @click="() => onSelect(document.id)"
        @keydown="(e) => handleKeyDown(e, document.id)"
        role="tab"
        :tabindex="activeDocumentId === document.id ? 0 : -1"
        :aria-selected="activeDocumentId === document.id"
        :class="[
          'group relative flex min-w-[120px] max-w-[240px] cursor-pointer items-center gap-2 rounded-t-md px-3 py-2.5 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500',
          activeDocumentId === document.id
            ? 'bg-white text-gray-900 shadow-[0_2px_4px_-1px_rgba(0,0,0,0.06)]'
            : 'bg-gray-200/60 text-gray-600 hover:bg-gray-200 hover:text-gray-800',
        ]"
      >
        <!-- Document Icon -->
        <DocumentIcon class="h-4 w-4 flex-shrink-0" aria-hidden="true" />

        <!-- Document Name -->
        <span class="min-w-0 flex-1 truncate">
          {{ document.name ?? `Document ${document.id.slice(0, 8)}` }}
        </span>

        <!-- Close Button -->
        <button
          @click.stop="() => onClose(document.id)"
          :aria-label="`Close ${document.name ?? 'document'}`"
          :class="[
            'flex-shrink-0 cursor-pointer rounded-full p-1 transition-all hover:bg-gray-300/50 focus:outline-none focus:ring-2 focus:ring-blue-500',
            activeDocumentId === document.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          ]"
          tabindex="-1"
        >
          <CloseIcon class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <!-- Add Tab (Open File) -->
      <button
        @click="onOpenFile"
        class="mb-2 ml-1 flex-shrink-0 cursor-pointer rounded p-1.5 text-gray-600 transition-colors hover:bg-gray-200/80 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="Open File"
        title="Open File"
      >
        <PlusIcon class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import type { DocumentState } from '@embedpdf/core';
import { DocumentIcon, CloseIcon, PlusIcon } from './icons';
import { useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/vue';

const props = defineProps<{
  documentStates: DocumentState[];
  activeDocumentId: string | null;
}>();

const tablistRef = ref<HTMLDivElement | null>(null);
const { provides } = useDocumentManagerCapability();

const onSelect = (id: string) => {
  provides.value?.setActiveDocument(id);
};

const onClose = (id: string) => {
  provides.value?.closeDocument(id);
};

const onOpenFile = () => {
  provides.value?.openFileDialog();
};

/** After selecting a tab, move DOM focus to the newly active [role=tab] element */
async function focusTab(id: string) {
  await nextTick();
  const el = tablistRef.value?.querySelector<HTMLElement>(`[role="tab"][aria-selected="true"]`);
  el?.focus();
}

const handleKeyDown = (e: KeyboardEvent, documentId: string) => {
  const currentIndex = props.documentStates.findIndex((d) => d.id === documentId);

  switch (e.key) {
    case 'Enter':
    case ' ':
      e.preventDefault();
      onSelect(documentId);
      break;

    case 'ArrowRight': {
      e.preventDefault();
      const next = props.documentStates[(currentIndex + 1) % props.documentStates.length];
      if (next) { onSelect(next.id); focusTab(next.id); }
      break;
    }

    case 'ArrowLeft': {
      e.preventDefault();
      const prev =
        props.documentStates[
          (currentIndex - 1 + props.documentStates.length) % props.documentStates.length
        ];
      if (prev) { onSelect(prev.id); focusTab(prev.id); }
      break;
    }

    case 'Home': {
      e.preventDefault();
      const first = props.documentStates[0];
      if (first) { onSelect(first.id); focusTab(first.id); }
      break;
    }

    case 'End': {
      e.preventDefault();
      const last = props.documentStates[props.documentStates.length - 1];
      if (last) { onSelect(last.id); focusTab(last.id); }
      break;
    }
  }
};
</script>
