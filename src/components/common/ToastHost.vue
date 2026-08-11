<script setup lang="ts">
import { useToasts } from "@composables/useToasts";

const { toasts, dismiss } = useToasts();
</script>

<template>
  <div class="host">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="toast.kind"
      @click="dismiss(toast.id)"
    >
      {{ toast.message }}
    </div>
  </div>
</template>

<style scoped>
.host {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 50;
}

.toast {
  background: var(--c-toast-bg);
  color: #fff;
  padding: 12px 20px;
  border-radius: var(--r-lg);
  font-size: 13.5px;
  font-weight: 500;
  box-shadow: var(--shadow-toast);
  animation: fadein 0.18s;
  cursor: pointer;
  max-width: 560px;
  text-align: center;
}

.toast.error {
  background: var(--c-danger-deep);
}

.toast.warning {
  background: var(--c-warn-deep);
}

.toast.success {
  background: var(--c-success-text);
}
</style>
