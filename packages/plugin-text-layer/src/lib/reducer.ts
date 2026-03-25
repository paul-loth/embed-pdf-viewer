import {
  TextLayerAction,
  INIT_TEXT_LAYER_STATE,
  CLEANUP_TEXT_LAYER_STATE,
  COMPLETE_TEXT_LAYER_INIT,
} from './actions';

export interface TextLayerDocumentState {
  initialized: boolean;
}

export interface TextLayerState {
  documents: Record<string, TextLayerDocumentState>;
}

export const initialDocumentState: TextLayerDocumentState = {
  initialized: false,
};

export const initialState: TextLayerState = {
  documents: {},
};

export const textLayerReducer = (
  state = initialState,
  action: TextLayerAction,
): TextLayerState => {
  switch (action.type) {
    case INIT_TEXT_LAYER_STATE: {
      const { documentId } = action.payload;
      return {
        ...state,
        documents: { ...state.documents, [documentId]: { ...initialDocumentState } },
      };
    }

    case COMPLETE_TEXT_LAYER_INIT: {
      const { documentId } = action.payload;
      const current = state.documents[documentId];
      if (!current) return state;

      return {
        ...state,
        documents: {
          ...state.documents,
          [documentId]: {
            ...current,
            initialized: true,
          },
        },
      };
    }

    case CLEANUP_TEXT_LAYER_STATE: {
      const documentId = action.payload;
      const { [documentId]: _removed, ...remaining } = state.documents;
      return { ...state, documents: remaining };
    }

    default:
      return state;
  }
};
