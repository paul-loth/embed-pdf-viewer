<script setup lang="ts">
/**
 * OffscreenTextDocument
 *
 * Renders the full text content of a PDF as visually-hidden HTML that is fully
 * accessible to screen readers.  The element is positioned off-screen using the
 * standard "sr-only" technique so sighted users never see it, while assistive
 * technologies read it in natural document order.
 *
 * Each page becomes a <section role="region" aria-label="Page N"> so screen
 * reader users can navigate between pages with the landmark shortcut.  Text
 * runs within a page are sorted into reading order before rendering.
 *
 * Pages are fetched in small sequential batches to avoid saturating the engine
 * worker while the visible render pipeline is still active.
 */
import { ref, watch, shallowRef, computed } from 'vue';
import { useDocumentState } from '@embedpdf/core/vue';
import type { PdfTextRun } from '@embedpdf/models';
import { useTextLayerCapability } from '../hooks';
import { sortByReadingOrder } from '../utils/reading-order';

interface Props {
  documentId: string;
}

const props = defineProps<Props>();

const { provides: textLayerProvides } = useTextLayerCapability();
const documentState = useDocumentState(() => props.documentId);

const document = computed(() => documentState.value?.document ?? null);
const pageCount = computed(() => document.value?.pages?.length ?? 0);

/** pageNumber (1-based) → sorted text runs (populated progressively as batches arrive) */
const allPageRuns = shallowRef<Map<number, PdfTextRun[]>>(new Map());

/** BCP-47 language tag for the document, or null */
const documentLanguage = ref<string | null>(null);

/** Token to cancel stale batch fetches when documentId/document changes */
let fetchToken: symbol | null = null;

function fetchAllPages(
  docId: string,
  capability: NonNullable<typeof textLayerProvides.value>,
  total: number,
  token: symbol,
  batchSize = 4,
): void {
  const results = new Map<number, PdfTextRun[]>();
  let batchStart = 0;

  function fetchBatch(start: number): void {
    if (fetchToken !== token) return;

    const end = Math.min(start + batchSize, total);
    let remaining = end - start;
    if (remaining <= 0) return;

    for (let i = start; i < end; i++) {
      const pageNumber = i + 1;
      capability.forDocument(docId).getTextRuns(i).wait(
        (runs) => {
          if (fetchToken !== token) return;
          results.set(pageNumber, sortByReadingOrder(runs));
          remaining--;
          if (remaining === 0) {
            // Snapshot the map to trigger Vue reactivity
            allPageRuns.value = new Map(results);
            if (end < total) {
              fetchBatch(end);
            }
          }
        },
        () => {
          if (fetchToken !== token) return;
          remaining--;
          if (remaining === 0 && end < total) {
            fetchBatch(end);
          }
        },
      );
    }
  }

  fetchBatch(batchStart);
}

watch(
  [() => props.documentId, document, textLayerProvides],
  ([docId, doc, capability]) => {
    // Cancel any in-flight fetch for the previous document
    fetchToken = null;
    allPageRuns.value = new Map();
    documentLanguage.value = null;

    if (!doc || !capability) return;

    const total = doc.pages?.length ?? 0;
    if (total === 0) return;

    // Fetch language
    capability.getDocumentLanguage(docId).wait(
      (lang) => {
        documentLanguage.value = lang;
      },
      () => {
        documentLanguage.value = null;
      },
    );

    // Kick off background page prefetch with a fresh token
    const token = Symbol('fetch');
    fetchToken = token;
    fetchAllPages(docId, capability, total, token);
  },
  { immediate: true },
);
</script>

<template>
  <!--
    Visually hidden container — positioned far off-screen so sighted users
    never see it, but screen readers still traverse the DOM and read it.
    Using the sr-only pattern rather than display:none / visibility:hidden
    which would also hide it from assistive technologies.
  -->
  <div
    v-if="pageCount > 0"
    :lang="documentLanguage ?? undefined"
    :style="{
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0,0,0,0)',
      whiteSpace: 'nowrap',
      borderWidth: '0',
    }"
  >
    <section
      v-for="pageNumber in pageCount"
      :key="pageNumber"
      role="region"
      :aria-label="`Page ${pageNumber}`"
    >
      <template v-if="allPageRuns.has(pageNumber)">
        <span
          v-for="(run, idx) in allPageRuns.get(pageNumber)"
          :key="idx"
        >{{ run.text }} </span>
      </template>
      <template v-else>
        <!-- placeholder while page text is still loading -->
      </template>
    </section>
  </div>
</template>
