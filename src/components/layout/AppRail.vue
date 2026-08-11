<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { RAIL_DESTINATIONS, type RailDestination } from "@app/router";
import { useBatches } from "@composables/useBatches";
import ConnectionFooter from "./ConnectionFooter.vue";

const route = useRoute();
const router = useRouter();

// Rail badge — the count of unfinished batches (Epic 03).
const { badgeCount } = useBatches();

function isActive(key: RailDestination): boolean {
  return route.meta.rail === key;
}

function go(routeName: string): void {
  void router.push({ name: routeName });
}
</script>

<template>
  <nav class="rail">
    <div class="brand">
      <div class="brand-chip">NB</div>
      <div class="brand-text">
        <div class="brand-name">NBCG Archive</div>
        <div class="brand-sub">Digital library client</div>
      </div>
    </div>

    <div class="section-label">Workspace</div>

    <button
      v-for="dest in RAIL_DESTINATIONS"
      :key="dest.key"
      class="nav-item"
      :class="{ active: isActive(dest.key) }"
      :title="dest.label"
      @click="go(dest.routeName)"
    >
      <span class="active-bar" />
      <span class="icon">
        <svg
          v-if="dest.key === 'overview'"
          viewBox="0 0 20 20"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
          <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
          <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
          <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
        </svg>
        <svg
          v-else-if="dest.key === 'batches'"
          viewBox="0 0 20 20"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <rect x="2.5" y="3" width="15" height="4.5" rx="1.4" />
          <rect x="2.5" y="9" width="15" height="4.5" rx="1.4" />
          <path d="M5 16.5h10" />
        </svg>
        <svg
          v-else-if="dest.key === 'sync'"
          viewBox="0 0 20 20"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <path d="M16 4.5A7 7 0 1 0 17 10" />
          <polyline points="16 2 16 5 13 5" />
        </svg>
        <svg
          v-else
          viewBox="0 0 20 20"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <circle cx="10" cy="10" r="6.5" />
          <circle cx="10" cy="10" r="1.8" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span>{{ dest.label }}</span>
      <span v-if="dest.key === 'batches' && badgeCount > 0" class="badge">
        {{ badgeCount }}
      </span>
    </button>

    <div class="footer-slot">
      <ConnectionFooter />
    </div>
  </nav>
</template>

<style scoped>
.rail {
  width: 236px;
  flex: none;
  background: var(--c-rail-gradient);
  color: var(--c-rail-text);
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 6px 8px 20px;
}

.brand-chip {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: var(--r-md);
  background: var(--c-rail-chip-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  letter-spacing: 0.5px;
  font-size: 15px;
  border: 1px solid var(--c-rail-chip-border);
}

.brand-text {
  line-height: 1.2;
}

.brand-name {
  font-weight: 600;
  font-size: 14px;
}

.brand-sub {
  font-size: 11px;
  color: var(--c-rail-text-faint);
  letter-spacing: 0.3px;
}

.section-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--c-rail-heading);
  padding: 4px 10px 8px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  margin-bottom: 3px;
  border-radius: var(--r-md);
  font-size: 14px;
  font-weight: 500;
  color: var(--c-rail-text-idle);
}

.nav-item.active {
  font-weight: 600;
  color: #fff;
  background: var(--c-rail-active-bg);
}

.active-bar {
  position: absolute;
  left: -14px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: #fff;
  opacity: 0;
}

.nav-item.active .active-bar {
  opacity: 1;
}

.icon {
  width: 20px;
  height: 20px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.badge {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  background: rgba(255, 255, 255, 0.16);
  padding: 1px 7px;
  border-radius: var(--r-pill);
}

.footer-slot {
  margin-top: auto;
  padding: 12px 10px 4px;
}
</style>
