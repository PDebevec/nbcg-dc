<script setup lang="ts">
import { computed } from "vue";
import type { ItemState } from "@domain/item";
import Pill from "@ui/common/Pill.vue";

const props = defineProps<{ state: ItemState; label: string }>();

/** Item state → pill tone. */
const TONES = {
  "to-process": "idle",
  "in-progress": "info",
  stopped: "danger",
  "needs-reupload": "warn",
  uploaded: "success",
} as const satisfies Record<ItemState, string>;

const tone = computed(() => TONES[props.state]);
</script>

<template>
  <Pill :tone="tone">{{ label }}</Pill>
</template>
