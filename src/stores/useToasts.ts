/**
 * Toast store — the app-wide notification queue (a global concern from Epic 01).
 * The GUI's `common/Toast.vue` renders `toasts`; any lane pushes via `push()`.
 */

import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  timeout: number;
}

export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  let seq = 0;

  function push(
    message: string,
    kind: ToastKind = "info",
    timeout = 4000,
  ): number {
    const id = ++seq;
    toasts.value.push({ id, kind, message, timeout });
    if (timeout > 0) {
      setTimeout(() => dismiss(id), timeout);
    }
    return id;
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function clear(): void {
    toasts.value = [];
  }

  return { toasts, push, dismiss, clear };
});
