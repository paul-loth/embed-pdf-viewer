---
'@embedpdf/plugin-annotation': patch
---

Fix link annotation click not working in the Vue build.

The template expression `@pointerdown="hasIRT ? undefined : onClick"` compiled to a function that returned the `onClick` reference instead of invoking it. Changed to `onClick?.($event)` so the handler is actually called on pointer down, restoring link selection and navigation. Thanks to @sebabal
