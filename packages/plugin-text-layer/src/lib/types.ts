import { BasePluginConfig } from '@embedpdf/core';
import { PdfTextRun, PdfTask } from '@embedpdf/models';

export interface TextLayerPluginConfig extends BasePluginConfig {
  /**
   * Whether the text layer is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Maximum number of pages whose text runs are kept in memory per document.
   * Oldest unused pages are evicted when the limit is exceeded.
   * @default 30
   */
  maxCachedPages?: number;
}

export interface TextLayerScope {
  getTextRuns(pageIndex: number): PdfTask<PdfTextRun[]>;
  /** BCP-47 language tag for this document, or null if not available. */
  getDocumentLanguage(): PdfTask<string | null>;
}

export interface TextLayerCapability {
  getTextRuns(documentId: string, pageIndex: number): PdfTask<PdfTextRun[]>;
  /** BCP-47 language tag for the given document, or null if not available. */
  getDocumentLanguage(documentId: string): PdfTask<string | null>;
  forDocument(documentId: string): TextLayerScope;
}
