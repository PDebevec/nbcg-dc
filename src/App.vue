<script setup lang="ts">
import AppRail from "./components/layout/AppRail.vue";
import ToastHost from "./components/common/ToastHost.vue";
</script>

<template>
  <div class="shell">
    <AppRail />
    <div class="main">
      <div class="screen">
        <router-view />
      </div>
    </div>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  width: 100%;
  overflow: hidden;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
}

.screen {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
