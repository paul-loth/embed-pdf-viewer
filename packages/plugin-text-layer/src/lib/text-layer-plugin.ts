import { BasePlugin, PluginRegistry, REFRESH_PAGES } from '@embedpdf/core';
import {
  PdfTextRun,
  PdfTask,
  PdfTaskHelper,
  PdfErrorCode,
  PdfErrorReason,
  Task,
} from '@embedpdf/models';
import { TextLayerCapability, TextLayerPluginConfig, TextLayerScope } from './types';
import {
  TextLayerAction,
  initTextLayerState,
  cleanupTextLayerState,
  completeTextLayerInit,
} from './actions';
import { TextLayerState } from './reducer';

export class TextLayerPlugin extends BasePlugin<
  TextLayerPluginConfig,
  TextLayerCapability,
  TextLayerState,
  TextLayerAction
> {
  static readonly id = 'text-layer' as const;

  private readonly config: TextLayerPluginConfig;

  /** In-memory cache: documentId → (pageIndex → text runs) */
  private cache = new Map<string, Map<number, PdfTextRun[]>>();

  /** LRU access order per document (oldest first) */
  private accessOrder = new Map<string, number[]>();

  /** BCP-47 language tag per document, populated on document load */
  private languageCache = new Map<string, string | null>();

  constructor(id: string, registry: PluginRegistry, config: TextLayerPluginConfig) {
    super(id, registry);
    this.config = config;

    this.coreStore.onAction(REFRESH_PAGES, (action) => {
      const { documentId, pageIndexes } = action.payload;
      const docCache = this.cache.get(documentId);
      if (!docCache) return;

      pageIndexes.forEach((pageIndex) => {
        docCache.delete(pageIndex);
        const order = this.accessOrder.get(documentId);
        if (order) {
          const idx = order.indexOf(pageIndex);
          if (idx > -1) order.splice(idx, 1);
        }
      });
    });
  }

  protected override onDocumentLoadingStarted(documentId: string): void {
    this.dispatch(initTextLayerState(documentId));
    this.cache.set(documentId, new Map());
    this.accessOrder.set(documentId, []);
  }

  protected override onDocumentLoaded(documentId: string): void {
    const coreDoc = this.getCoreDocument(documentId);
    if (!coreDoc?.document) {
      this.dispatch(completeTextLayerInit(documentId));
      return;
    }

    this.engine.getMetadata(coreDoc.document).wait(
      (metadata) => {
        this.languageCache.set(documentId, metadata.language ?? null);
        this.dispatch(completeTextLayerInit(documentId));
      },
      () => {
        this.languageCache.set(documentId, null);
        this.dispatch(completeTextLayerInit(documentId));
      },
    );
  }

  protected override onDocumentClosed(documentId: string): void {
    this.dispatch(cleanupTextLayerState(documentId));
    this.cache.delete(documentId);
    this.accessOrder.delete(documentId);
    this.languageCache.delete(documentId);
  }

  protected buildCapability(): TextLayerCapability {
    return {
      getTextRuns: (documentId: string, pageIndex: number) =>
        this.getTextRuns(documentId, pageIndex),
      getDocumentLanguage: (documentId: string) => this.getDocumentLanguage(documentId),
      forDocument: (documentId: string) => this.createScope(documentId),
    };
  }

  private createScope(documentId: string): TextLayerScope {
    return {
      getTextRuns: (pageIndex: number) => this.getTextRuns(documentId, pageIndex),
      getDocumentLanguage: () => this.getDocumentLanguage(documentId),
    };
  }

  private getTextRuns(documentId: string, pageIndex: number): PdfTask<PdfTextRun[]> {
    const docCache = this.cache.get(documentId);
    if (!docCache) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.NotFound,
        message: `TextLayerPlugin: document ${documentId} not loaded`,
      });
    }

    const cached = docCache.get(pageIndex);
    if (cached) {
      this.touch(documentId, pageIndex);
      return PdfTaskHelper.resolve(cached);
    }

    return this.fetchAndCache(documentId, pageIndex);
  }

  private getDocumentLanguage(documentId: string): PdfTask<string | null> {
    if (this.languageCache.has(documentId)) {
      return PdfTaskHelper.resolve<string | null>(this.languageCache.get(documentId) ?? null);
    }

    const coreDoc = this.getCoreDocument(documentId);
    if (!coreDoc?.document) {
      return PdfTaskHelper.resolve<string | null>(null);
    }

    const resultTask = new Task<string | null, PdfErrorReason>();
    this.engine.getMetadata(coreDoc.document).wait(
      (metadata) => {
        const lang = metadata.language ?? null;
        this.languageCache.set(documentId, lang);
        resultTask.resolve(lang);
      },
      () => {
        this.languageCache.set(documentId, null);
        resultTask.resolve(null);
      },
    );
    return resultTask;
  }

  private fetchAndCache(documentId: string, pageIndex: number): PdfTask<PdfTextRun[]> {
    const coreDoc = this.getCoreDocument(documentId);
    if (!coreDoc?.document) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.NotFound,
        message: `TextLayerPlugin: document ${documentId} not found`,
      });
    }

    const page = coreDoc.document.pages.find((p) => p.index === pageIndex);
    if (!page) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.NotFound,
        message: `TextLayerPlugin: page ${pageIndex} not found in document ${documentId}`,
      });
    }

    const sourceTask = this.engine.getPageTextRuns(coreDoc.document, page);
    const resultTask = new Task<PdfTextRun[], PdfErrorReason>();

    sourceTask.wait(
      (result) => {
        const docCache = this.cache.get(documentId);
        if (docCache) {
          docCache.set(pageIndex, result.runs);
          this.touch(documentId, pageIndex);
        }
        resultTask.resolve(result.runs);
      },
      (err) => resultTask.reject(err.reason),
    );

    return resultTask;
  }

  private touch(documentId: string, pageIndex: number): void {
    const order = this.accessOrder.get(documentId);
    if (!order) return;

    const idx = order.indexOf(pageIndex);
    if (idx > -1) order.splice(idx, 1);
    order.push(pageIndex);

    this.evictIfNeeded(documentId);
  }

  private evictIfNeeded(documentId: string): void {
    const max = this.config.maxCachedPages ?? 30;
    const order = this.accessOrder.get(documentId);
    const docCache = this.cache.get(documentId);
    if (!order || !docCache || order.length <= max) return;

    while (order.length > max) {
      const oldest = order.shift();
      if (oldest !== undefined) {
        docCache.delete(oldest);
      }
    }
  }

  async initialize(_config: TextLayerPluginConfig): Promise<void> {
    this.logger.info('TextLayerPlugin', 'Initialize', 'Text layer plugin initialized');
  }

  async destroy(): Promise<void> {
    this.cache.clear();
    this.accessOrder.clear();
    this.languageCache.clear();
    super.destroy();
  }
}
