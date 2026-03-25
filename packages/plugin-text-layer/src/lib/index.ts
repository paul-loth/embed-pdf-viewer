import { PluginPackage } from '@embedpdf/core';
import { manifest, TEXT_LAYER_PLUGIN_ID } from './manifest';
import { TextLayerPluginConfig } from './types';
import { TextLayerPlugin } from './text-layer-plugin';
import { TextLayerAction } from './actions';
import { TextLayerState, textLayerReducer, initialState } from './reducer';

export const TextLayerPluginPackage: PluginPackage<
  TextLayerPlugin,
  TextLayerPluginConfig,
  TextLayerState,
  TextLayerAction
> = {
  manifest,
  create: (registry, config) => new TextLayerPlugin(TEXT_LAYER_PLUGIN_ID, registry, config),
  reducer: textLayerReducer,
  initialState,
};

export * from './text-layer-plugin';
export * from './types';
export * from './manifest';
export * from './actions';
export * from './reducer';
