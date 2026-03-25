<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useDocumentState } from '@embedpdf/core/vue';
import type { PdfTextRun } from '@embedpdf/models';
import { useTextLayerCapability } from '../hooks';
import { sortByReadingOrder } from '../utils/reading-order';

interface TextLayerProps {
  documentId: string;
  pageIndex: number;
  scale?: number;
}

const props = defineProps<TextLayerProps>();

const { provides: textLayerProvides } = useTextLayerCapability();
const documentState = useDocumentState(() => props.documentId);

const textRuns = ref<PdfTextRun[]>([]);

const actualScale = computed(() => {
  if (props.scale !== undefined) return props.scale;
  return documentState.value?.scale ?? 1;
});

const refreshVersion = computed(() => {
  if (!documentState.value) return 0;
  return documentState.value.pageRefreshVersions[props.pageIndex] ?? 0;
});

watch(
  [() => props.documentId, () => props.pageIndex, textLayerProvides, refreshVersion],
  ([docId, pageIdx, capability]) => {
    if (!capability) {
      textRuns.value = [];
      return;
    }

    capability.forDocument(docId).getTextRuns(pageIdx).wait(
      (runs) => {
        textRuns.value = sortByReadingOrder(runs);
      },
      () => {
        textRuns.value = [];
      },
    );
  },
  { immediate: true },
);
</script>

<template>
  <!-- aria-hidden: AT reads from OffscreenTextDocument instead to avoid duplicate announcements -->
  <div
    v-if="textRuns.length > 0"
    aria-hidden="true"
    :style="{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      overflow: 'hidden',
      pointerEvents: 'none',
    }"
    v-bind="$attrs"
  >
    <span
      v-for="(run, index) in textRuns"
      :key="index"
      :style="{
        position: 'absolute',
        left: `${run.rect.origin.x * actualScale}px`,
        top: `${run.rect.origin.y * actualScale}px`,
        width: `${run.rect.size.width * actualScale}px`,
        height: `${run.rect.size.height * actualScale}px`,
        fontSize: `${run.fontSize * actualScale}px`,
        fontFamily: run.font.familyName || 'sans-serif',
        lineHeight: 1,
        whiteSpace: 'pre',
        color: 'transparent',
        transformOrigin: '0 0',
      }"
    >{{ run.text }}</span>
  </div>
</template>
