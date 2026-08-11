/**
 * `useToasts` (Epic 01) — the view-model the toast host binds to (Seam 1:
 * Presentation ↔ Application). `common/ToastHost.vue` imports only this; other
 * composables push through the store directly.
 */

import { storeToRefs } from "pinia";
import { useToastsStore, type ToastKind } from "@stores/useToasts";

export type { Toast, ToastKind } from "@stores/useToasts";

export function useToasts() {
  const store = useToastsStore();
  const { toasts } = storeToRefs(store);

  function dismiss(id: number): void {
    store.dismiss(id);
  }

  function push(message: string, kind: ToastKind = "info"): number {
    return store.push(message, kind);
  }

  return { toasts, dismiss, push };
}
