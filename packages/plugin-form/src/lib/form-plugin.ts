import {
  BasePlugin,
  createBehaviorEmitter,
  createEmitter,
  Listener,
  PluginRegistry,
} from '@embedpdf/core';
import {
  FieldGroupEntry,
  FieldValueChangeEvent,
  FormCapability,
  FormDocumentState,
  FormPluginConfig,
  FormScope,
  FormState,
  FormStateChangeEvent,
  RenderWidgetOptions,
} from './types';
import {
  FormAction,
  initFormState,
  cleanupFormState,
  selectField as selectFieldAction,
  deselectField as deselectFieldAction,
} from './actions';
import {
  PdfAnnotationObject,
  PdfAnnotationSubtype,
  PdfDocumentObject,
  PdfErrorCode,
  PdfErrorReason,
  PdfJavaScriptWidgetEventType,
  PdfTask,
  PdfTaskHelper,
  PdfWidgetAnnoField,
  PdfWidgetJavaScriptActionObject,
  PdfWidgetAnnoObject,
  Task,
  TaskSequence,
} from '@embedpdf/models';
import {
  AnnotationCapability,
  AnnotationEvent,
  AnnotationPlugin,
} from '@embedpdf/plugin-annotation';
import { Command, HistoryCapability, HistoryPlugin } from '@embedpdf/plugin-history';
import { initialDocumentState } from './reducer';
import { formTools } from './tools';
import { runHelperPdfJsBatch } from './pdf-js/helper-runtime';

export class FormPlugin extends BasePlugin<
  FormPluginConfig,
  FormCapability,
  FormState,
  FormAction
> {
  static readonly id = 'form' as const;

  private readonly FORM_HISTORY_TOPIC = 'form-fields';

  private annotation: AnnotationCapability | null = null;
  private history: HistoryCapability | null = null;

  private readonly state$ = createBehaviorEmitter<FormStateChangeEvent>();
  private readonly fieldValueChange$ = createEmitter<FieldValueChangeEvent>();

  /** Per-document field name index: documentId → (fieldName → FieldGroupEntry[]) */
  private readonly fieldNameIndex = new Map<string, Map<string, FieldGroupEntry[]>>();

  /** IDs currently being propagated to siblings; prevents recursive loops */
  private readonly propagationInProgress = new Set<string>();

  constructor(id: string, registry: PluginRegistry, _config: FormPluginConfig) {
    super(id, registry);

    this.annotation = registry.getPlugin<AnnotationPlugin>('annotation')?.provides() ?? null;
    this.history = registry.getPlugin<HistoryPlugin>(HistoryPlugin.id)?.provides() ?? null;

    if (this.annotation) {
      for (const tool of formTools) {
        this.annotation.addTool(tool);
      }
      this.annotation.onAnnotationEvent((event) => this.handleAnnotationEvent(event));
    }
  }

  async initialize(): Promise<void> {}

  protected override onDocumentLoadingStarted(documentId: string): void {
    this.dispatch(initFormState(documentId, { ...initialDocumentState }));
  }

  protected override onDocumentClosed(documentId: string): void {
    this.dispatch(cleanupFormState(documentId));
    this.fieldNameIndex.delete(documentId);
  }

  override onStoreUpdated(prev: FormState, next: FormState): void {
    for (const documentId in next.documents) {
      const prevDoc = prev.documents[documentId];
      const nextDoc = next.documents[documentId];
      if (prevDoc !== nextDoc) {
        this.state$.emit({ documentId, state: nextDoc });
      }
    }
  }

  protected buildCapability(): FormCapability {
    return {
      getPageFormAnnoWidgets: (pageIndex, documentId?) =>
        this.getPageFormAnnoWidgets(pageIndex, documentId),
      setFormFieldValues: (pageIndex, annotation, newField, documentId?) =>
        this.setFormFieldValues(pageIndex, annotation, newField, documentId),
      renderWidget: (options, documentId?) => this.renderWidget(options, documentId),
      selectField: (annotationId, documentId?) => this.selectFieldMethod(annotationId, documentId),
      deselectField: (documentId?) => this.deselectFieldMethod(documentId),
      getSelectedFieldId: (documentId?) => this.getSelectedFieldId(documentId),
      getState: (documentId?) => this.getDocumentState(documentId),
      getFieldGroup: (annotationId, documentId?) => this.getFieldGroup(annotationId, documentId),
      getFieldSiblings: (annotationId, documentId?) =>
        this.getFieldSiblings(annotationId, documentId),
      forDocument: (documentId) => this.createFormScope(documentId),
      onStateChange: this.state$.on,
      onFieldValueChange: this.fieldValueChange$.on,
    };
  }

  private createFormScope(documentId: string): FormScope {
    return {
      getPageFormAnnoWidgets: (pageIndex) => this.getPageFormAnnoWidgets(pageIndex, documentId),
      setFormFieldValues: (pageIndex, annotation, newField) =>
        this.setFormFieldValues(pageIndex, annotation, newField, documentId),
      renderWidget: (options) => this.renderWidget(options, documentId),
      selectField: (annotationId) => this.selectFieldMethod(annotationId, documentId),
      deselectField: () => this.deselectFieldMethod(documentId),
      getSelectedFieldId: () => this.getSelectedFieldId(documentId),
      getState: () => this.getDocumentState(documentId),
      getFieldGroup: (annotationId) => this.getFieldGroup(annotationId, documentId),
      getFieldSiblings: (annotationId) => this.getFieldSiblings(annotationId, documentId),
      onStateChange: (listener: Listener<FormDocumentState>) =>
        this.state$.on((event) => {
          if (event.documentId === documentId) listener(event.state);
        }),
      onFieldValueChange: (listener: Listener<FieldValueChangeEvent>) =>
        this.fieldValueChange$.on((event) => {
          if (event.documentId === documentId) listener(event);
        }),
    };
  }

  private handleAnnotationEvent(event: AnnotationEvent): void {
    switch (event.type) {
      case 'loaded':
        this.buildFieldNameIndex(event.documentId);
        break;

      case 'create': {
        const anno = event.annotation;
        if (anno.type !== PdfAnnotationSubtype.WIDGET) break;
        const widget = anno as PdfWidgetAnnoObject;
        const fieldName = widget.field?.name;
        if (!fieldName) break;
        const idx = this.getDocIndex(event.documentId);
        const group = idx.get(fieldName) ?? [];
        if (!group.some((e) => e.annotationId === anno.id)) {
          group.push({ annotationId: anno.id, pageIndex: anno.pageIndex });
          idx.set(fieldName, group);
        }
        break;
      }

      case 'delete': {
        const anno = event.annotation;
        if (anno.type !== PdfAnnotationSubtype.WIDGET) break;
        const widget = anno as PdfWidgetAnnoObject;
        const fieldName = widget.field?.name;
        if (!fieldName) break;
        const idx = this.fieldNameIndex.get(event.documentId);
        if (!idx) break;
        const group = idx.get(fieldName);
        if (!group) break;
        const filtered = group.filter((e) => e.annotationId !== anno.id);
        if (filtered.length === 0) {
          idx.delete(fieldName);
        } else {
          idx.set(fieldName, filtered);
        }
        break;
      }

      case 'update': {
        if (!event.committed) break;
        const anno = event.annotation;
        if (anno.type !== PdfAnnotationSubtype.WIDGET) break;

        if (this.propagationInProgress.has(anno.id)) {
          this.propagationInProgress.delete(anno.id);
          break;
        }

        const patch = event.patch as Partial<PdfWidgetAnnoObject>;

        if (patch.field?.name) {
          this.buildFieldNameIndex(event.documentId);
        }

        this.propagateFieldLevelChanges(event.documentId, anno, patch);
        break;
      }
    }
  }

  private propagateFieldLevelChanges(
    documentId: string,
    annotation: PdfAnnotationObject,
    patch: Partial<PdfWidgetAnnoObject>,
  ): void {
    if (!this.annotation || !patch.field) return;

    const fieldPatch = patch.field;

    const siblings = this.getFieldSiblings(annotation.id, documentId);
    if (siblings.length === 0) return;

    const siblingPatches: Array<{
      pageIndex: number;
      id: string;
      patch: Partial<PdfAnnotationObject>;
    }> = [];

    for (const sibling of siblings) {
      this.propagationInProgress.add(sibling.annotationId);
      siblingPatches.push({
        pageIndex: sibling.pageIndex,
        id: sibling.annotationId,
        patch: { field: { ...fieldPatch } } as Partial<PdfAnnotationObject>,
      });
    }

    this.annotation.forDocument(documentId).updateAnnotations(siblingPatches);
  }

  private buildFieldNameIndex(documentId: string): void {
    if (!this.annotation) return;
    const annoState = this.annotation.forDocument(documentId).getState();
    if (!annoState) return;

    const idx = new Map<string, FieldGroupEntry[]>();

    for (const [pageStr, uids] of Object.entries(annoState.pages)) {
      const pageIndex = Number(pageStr);
      for (const uid of uids) {
        const tracked = annoState.byUid[uid];
        if (!tracked || tracked.object.type !== PdfAnnotationSubtype.WIDGET) continue;
        const widget = tracked.object as PdfWidgetAnnoObject;
        const fieldName = widget.field?.name;
        if (!fieldName) continue;

        const group = idx.get(fieldName) ?? [];
        group.push({ annotationId: uid, pageIndex });
        idx.set(fieldName, group);
      }
    }

    this.fieldNameIndex.set(documentId, idx);
  }

  private getDocumentState(documentId?: string): FormDocumentState {
    const id = documentId ?? this.getActiveDocumentId();
    return this.state.documents[id] ?? { ...initialDocumentState };
  }

  // ─────────────────────────────────────────────────────────
  // Field Name Index
  // ─────────────────────────────────────────────────────────

  private getDocIndex(documentId: string): Map<string, FieldGroupEntry[]> {
    let idx = this.fieldNameIndex.get(documentId);
    if (!idx) {
      idx = new Map();
      this.fieldNameIndex.set(documentId, idx);
    }
    return idx;
  }

  private getFieldNameForAnnotation(annotationId: string, documentId: string): string | null {
    const idx = this.fieldNameIndex.get(documentId);
    if (!idx) return null;
    for (const [name, entries] of idx) {
      if (entries.some((e) => e.annotationId === annotationId)) return name;
    }
    return null;
  }

  public getFieldGroup(annotationId: string, documentId?: string): FieldGroupEntry[] {
    const docId = documentId ?? this.getActiveDocumentId();
    const fieldName = this.getFieldNameForAnnotation(annotationId, docId);
    if (!fieldName) return [];
    return this.getDocIndex(docId).get(fieldName) ?? [];
  }

  public getFieldSiblings(annotationId: string, documentId?: string): FieldGroupEntry[] {
    return this.getFieldGroup(annotationId, documentId).filter(
      (e) => e.annotationId !== annotationId,
    );
  }

  private getDocumentWidgets(
    documentId: string,
  ): Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }> {
    if (!this.annotation) return new Map();
    const docState = this.annotation.forDocument(documentId).getState();
    const widgets = new Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }>();

    for (const [annotationId, tracked] of Object.entries(docState.byUid)) {
      if (tracked.object.type !== PdfAnnotationSubtype.WIDGET) continue;
      widgets.set(annotationId, {
        widget: tracked.object as PdfWidgetAnnoObject,
        pageIndex: tracked.object.pageIndex,
      });
    }

    return widgets;
  }

  private getFieldEntriesForNames(
    fieldNames: Iterable<string>,
    documentId: string,
  ): FieldGroupEntry[] {
    const docIndex = this.getDocIndex(documentId);
    const seen = new Set<string>();
    const entries: FieldGroupEntry[] = [];

    for (const fieldName of fieldNames) {
      const group = docIndex.get(fieldName) ?? [];
      for (const entry of group) {
        if (seen.has(entry.annotationId)) continue;
        seen.add(entry.annotationId);
        entries.push(entry);
      }
    }

    return entries;
  }

  private groupWidgetJavaScriptActions(
    actions: PdfWidgetJavaScriptActionObject[],
    annotationId: string,
    fieldName: string,
  ) {
    const forCurrentWidget = (trigger: PdfWidgetJavaScriptActionObject['eventType']) =>
      actions.filter(
        (action) => action.annotationId === annotationId && action.eventType === trigger,
      );
    const formatActions = actions.filter(
      (action) => action.eventType === PdfJavaScriptWidgetEventType.Format,
    );
    const calculateActions = actions.filter(
      (action) => action.eventType === PdfJavaScriptWidgetEventType.Calculate,
    );

    return {
      keystroke: forCurrentWidget(PdfJavaScriptWidgetEventType.Keystroke),
      validate: forCurrentWidget(PdfJavaScriptWidgetEventType.Validate),
      format: formatActions.filter(
        (action) => action.fieldName === fieldName || action.annotationId === annotationId,
      ),
      calculate: calculateActions,
    };
  }

  private async applyFieldBatchToEngine(
    doc: PdfDocumentObject,
    batch: Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }>,
  ): Promise<void> {
    const fieldGroups = new Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }[]>();
    for (const entry of batch.values()) {
      const fieldName = entry.widget.field?.name;
      if (!fieldName) continue;
      const group = fieldGroups.get(fieldName) ?? [];
      group.push(entry);
      fieldGroups.set(fieldName, group);
    }

    for (const entries of fieldGroups.values()) {
      const checkedEntry = entries.find(
        (entry) => 'isChecked' in entry.widget.field && entry.widget.field.isChecked,
      );
      const target = checkedEntry ?? entries[0];
      if (!target) continue;
      const page = doc.pages.find((candidate) => candidate.index === target.pageIndex);
      if (!page) continue;

      await new Promise<void>((resolve) => {
        this.engine.setFormFieldState(doc, page, target.widget, target.widget.field).wait(
          () => resolve(),
          () => resolve(),
        );
      });
    }

    for (const pageIndex of new Set([...batch.values()].map((entry) => entry.pageIndex))) {
      const page = doc.pages.find((candidate) => candidate.index === pageIndex);
      if (!page) continue;
      const ids = [...batch.entries()]
        .filter(([, entry]) => entry.pageIndex === pageIndex)
        .map(([id]) => id);
      await new Promise<void>((resolve) => {
        this.engine.regenerateWidgetAppearances(doc, page, ids).wait(
          () => resolve(),
          () => resolve(),
        );
      });
    }
  }

  private getPageFormAnnoWidgets(
    pageIndex: number,
    documentId?: string,
  ): PdfTask<PdfWidgetAnnoObject[]> {
    const docState = this.getCoreDocumentOrThrow(documentId);
    const doc = docState.document;

    if (!doc) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.DocNotOpen,
        message: 'document is not open',
      });
    }

    const page = doc.pages.find((p) => p.index === pageIndex);
    if (!page) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.NotFound,
        message: 'page does not exist',
      });
    }

    return this.engine.getPageAnnoWidgets(doc, page);
  }

  private setFormFieldValues(
    pageIndex: number,
    annotation: PdfWidgetAnnoObject,
    newField: PdfWidgetAnnoField,
    documentId?: string,
  ): PdfTask<boolean> {
    const docId = documentId ?? this.getActiveDocumentId();
    const coreDoc = this.getCoreDocumentOrThrow(docId);
    const doc = coreDoc.document;

    if (!doc) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.DocNotOpen,
        message: 'document is not open',
      });
    }

    const page = doc.pages.find((p) => p.index === pageIndex);
    if (!page) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.NotFound,
        message: 'page does not exist',
      });
    }

    const resultTask = new Task<boolean, PdfErrorReason>();
    const seq = new TaskSequence(resultTask);

    seq.execute(
      async () => {
        const widgetsById = this.getDocumentWidgets(docId);
        const currentFieldName = newField.name || annotation.field?.name;

        const pageActions: PdfWidgetJavaScriptActionObject[] = [];
        for (const docPage of doc.pages) {
          const actions = await seq.run(() =>
            this.engine.getPageWidgetJavaScriptActions(doc, docPage),
          );
          pageActions.push(...actions);
        }

        const runtimeResult = runHelperPdfJsBatch(
          {
            widgets: [...widgetsById.values()].map((entry) => entry.widget),
            currentAnnotationId: annotation.id,
            proposedField: newField,
          },
          this.groupWidgetJavaScriptActions(pageActions, annotation.id, currentFieldName),
        );

        if (!runtimeResult.accepted) {
          resultTask.resolve(false);
          return;
        }

        const touchedFieldNames = new Set(runtimeResult.touchedFieldNames);
        const fallbackEntries = this.getFieldGroup(annotation.id, docId);
        const fieldEntries = this.getFieldEntriesForNames(touchedFieldNames, docId);
        const affectedEntries = fieldEntries.length > 0 ? fieldEntries : fallbackEntries;
        const pageSet = new Set(affectedEntries.map((entry) => entry.pageIndex));
        const memberIds = new Set(affectedEntries.map((entry) => entry.annotationId));

        const beforeMap = new Map<string, PdfWidgetAnnoObject>();
        for (const entry of affectedEntries) {
          const before = widgetsById.get(entry.annotationId)?.widget;
          if (before) beforeMap.set(entry.annotationId, before);
        }

        const applyBatch = new Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }>();
        for (const [fieldName, fieldState] of runtimeResult.fieldStates) {
          const entries = this.getDocIndex(docId).get(fieldName) ?? [];
          for (const entry of entries) {
            const existing = widgetsById.get(entry.annotationId);
            if (!existing) continue;
            applyBatch.set(entry.annotationId, {
              widget: {
                ...existing.widget,
                field: fieldState,
              },
              pageIndex: entry.pageIndex,
            });
          }
        }

        if (applyBatch.size === 0) {
          applyBatch.set(annotation.id, {
            widget: { ...annotation, field: newField },
            pageIndex,
          });
        }

        // 1. Apply field state changes to the engine.
        await this.applyFieldBatchToEngine(doc, applyBatch);

        // 2. Re-read fresh state for all affected widgets across pages.
        const afterMap = new Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }>();
        for (const pi of pageSet) {
          const pg = doc.pages.find((p) => p.index === pi);
          if (!pg) continue;
          const widgets = await seq.run(() => this.engine.getPageAnnoWidgets(doc, pg));
          for (const w of widgets) {
            if (memberIds.has(w.id)) afterMap.set(w.id, { widget: w, pageIndex: pi });
          }
        }

        // 3. Sync all affected members to annotation plugin and emit change events.
        const syncAndEmit = (
          batch: Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }>,
        ) => {
          if (!this.annotation) return;
          for (const [id, { widget, pageIndex: pi }] of batch) {
            this.annotation.syncAnnotationObject(id, widget, docId);
            this.annotation.invalidatePageAppearances(pi, docId);
            this.fieldValueChange$.emit({
              documentId: docId,
              pageIndex: pi,
              annotationId: id,
              widget,
            });
          }
        };

        // 4. Build and register history command.
        let isFirstExecution = true;

        const applyToEngine = async (
          batch: Map<string, { widget: PdfWidgetAnnoObject; pageIndex: number }>,
        ) => {
          await this.applyFieldBatchToEngine(doc, batch);
        };

        const command: Command = {
          execute: () => {
            const skipEngine = isFirstExecution;
            isFirstExecution = false;

            if (skipEngine) {
              syncAndEmit(afterMap);
            } else {
              applyToEngine(afterMap).then(() => syncAndEmit(afterMap));
            }
          },

          undo: () => {
            const beforeEntries = new Map<
              string,
              { widget: PdfWidgetAnnoObject; pageIndex: number }
            >();
            for (const [id, widget] of beforeMap) {
              const entry = affectedEntries.find((e) => e.annotationId === id);
              if (entry) beforeEntries.set(id, { widget, pageIndex: entry.pageIndex });
            }
            applyToEngine(beforeEntries).then(() => syncAndEmit(beforeEntries));
          },
        };

        if (this.history) {
          this.history.forDocument(docId).register(command, this.FORM_HISTORY_TOPIC);
        } else {
          command.execute();
        }

        resultTask.resolve(true);
      },
      (err) => ({ code: PdfErrorCode.Unknown, message: String(err) }),
    );

    return resultTask;
  }

  private selectFieldMethod(annotationId: string, documentId?: string): void {
    const docId = documentId ?? this.getActiveDocumentId();
    this.dispatch(selectFieldAction(docId, annotationId));
  }

  private deselectFieldMethod(documentId?: string): void {
    const docId = documentId ?? this.getActiveDocumentId();
    this.dispatch(deselectFieldAction(docId));
  }

  private getSelectedFieldId(documentId?: string): string | null {
    return this.getDocumentState(documentId).selectedFieldId;
  }

  private renderWidget(
    options: RenderWidgetOptions,
    documentId?: string,
  ): Task<Blob, PdfErrorReason> {
    if (!this.annotation) {
      return PdfTaskHelper.reject({
        code: PdfErrorCode.NotFound,
        message: 'annotation plugin not found',
      });
    }

    const id = documentId ?? this.getActiveDocumentId();
    return this.annotation.forDocument(id).renderAnnotation(options);
  }

  async destroy(): Promise<void> {
    this.state$.clear();
    this.fieldValueChange$.clear();
    super.destroy();
  }
}
