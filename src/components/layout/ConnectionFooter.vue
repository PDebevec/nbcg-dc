<script setup lang="ts">
import { useConnection } from "@composables/useConnection";

const { label, hostLabel, online } = useConnection();
</script>

<template>
  <div class="footer">
    <span class="dot" :class="{ online }" />
    <div class="text">
      <div class="label">{{ label }}</div>
      <div class="host">{{ hostLabel }}</div>
    </div>
  </div>
</template>

<style scoped>
.footer {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--r-md);
  background: var(--c-rail-footer-bg);
  font-size: 12.5px;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  background: var(--c-conn-offline);
  box-shadow: 0 0 0 3px var(--c-conn-offline-halo);
}

.dot.online {
  background: var(--c-conn-online);
  box-shadow: 0 0 0 3px var(--c-conn-online-halo);
}

.text {
  line-height: 1.25;
}

.label {
  font-weight: 600;
  color: #f2f3fd;
}

.host {
  font-size: 11px;
  color: var(--c-rail-text-faint);
  font-family: var(--font-mono);
}
</style>
