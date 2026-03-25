import { PluginManifest } from '@embedpdf/core';
import { TextLayerPluginConfig } from './types';

export const TEXT_LAYER_PLUGIN_ID = 'text-layer';

export const manifest: PluginManifest<TextLayerPluginConfig> = {
  id: TEXT_LAYER_PLUGIN_ID,
  name: 'Text Layer Plugin',
  version: '1.0.0',
  provides: ['text-layer'],
  requires: [],
  optional: [],
  defaultConfig: {
    enabled: true,
    maxCachedPages: 30,
  },
};
