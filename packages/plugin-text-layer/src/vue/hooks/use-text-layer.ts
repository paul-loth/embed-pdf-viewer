import { useCapability, usePlugin } from '@embedpdf/core/vue';
import { TextLayerPlugin } from '@embedpdf/plugin-text-layer';

export const useTextLayerPlugin = () => usePlugin<TextLayerPlugin>(TextLayerPlugin.id);
export const useTextLayerCapability = () => useCapability<TextLayerPlugin>(TextLayerPlugin.id);
