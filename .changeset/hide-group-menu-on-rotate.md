---
'@embedpdf/plugin-annotation': patch
---

Hide the group selection menu while group rotation is active. Previously the menu remained visible during rotation, which could overlap with rotation guide lines and the tooltip. This aligns the group selection box behavior with the single-annotation container, which already hides its menu during rotation.
