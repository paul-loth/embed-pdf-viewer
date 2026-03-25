import { Action } from '@embedpdf/core';

export const INIT_TEXT_LAYER_STATE = 'TEXT_LAYER/INIT_STATE';
export const CLEANUP_TEXT_LAYER_STATE = 'TEXT_LAYER/CLEANUP_STATE';
export const COMPLETE_TEXT_LAYER_INIT = 'TEXT_LAYER/COMPLETE_INIT';

export interface InitTextLayerStateAction extends Action {
  type: typeof INIT_TEXT_LAYER_STATE;
  payload: { documentId: string };
}

export interface CleanupTextLayerStateAction extends Action {
  type: typeof CLEANUP_TEXT_LAYER_STATE;
  payload: string;
}

export interface CompleteTextLayerInitAction extends Action {
  type: typeof COMPLETE_TEXT_LAYER_INIT;
  payload: { documentId: string };
}

export type TextLayerAction =
  | InitTextLayerStateAction
  | CleanupTextLayerStateAction
  | CompleteTextLayerInitAction;

export const initTextLayerState = (documentId: string): InitTextLayerStateAction => ({
  type: INIT_TEXT_LAYER_STATE,
  payload: { documentId },
});

export const cleanupTextLayerState = (documentId: string): CleanupTextLayerStateAction => ({
  type: CLEANUP_TEXT_LAYER_STATE,
  payload: documentId,
});

export const completeTextLayerInit = (documentId: string): CompleteTextLayerInitAction => ({
  type: COMPLETE_TEXT_LAYER_INIT,
  payload: { documentId },
});
