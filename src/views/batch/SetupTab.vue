<script setup lang="ts">
import { useBatchSetup } from "@composables/useBatchSetup";
import SegmentedControl from "../../components/common/SegmentedControl.vue";
import ParentRecordsCard from "../../components/batch/ParentRecordsCard.vue";

const props = defineProps<{ batchId: string }>();

const emit = defineEmits<{ continue: [] }>();

const {
  cobissId,
  cobissSet,
  setCobissId,
  parents,
  parentQuery,
  setParentQuery,
  parentResults,
  parentSearching,
  parentSearchError,
  linkParent,
  removeParent,
  togglePassesData,
  publish,
  setPublish,
  visibility,
  setVisibility,
  editable,
  itemCount,
  applying,
  applyAndContinue,
} = useBatchSetup(() => props.batchId);

const publishOptions = [
  { value: "DRAFT", label: "Draft" },
  { value: "RECORD", label: "Record" },
];

const visibilityOptions = [
  { value: "PUBLIC", label: "Public" },
  { value: "PRIVATE", label: "Private" },
  { value: "HIDDEN", label: "Hidden" },
];

async function onContinue(): Promise<void> {
  const ok = await applyAndContinue();
  if (ok) emit("continue");
}
</script>

<template>
  <div class="tab">
    <div class="banner">
      <span class="banner-num">1</span>
      <span>
        These settings apply to <b>all {{ itemCount }} items</b> in the batch.
        You can still override each item in the next step.
      </span>
    </div>

    <!-- COBISS -->
    <div class="card">
      <div class="heading">Prefill from COBISS</div>
      <div class="desc">
        If set, every item is prefilled with this COBISS record's data —
        overriding parent-inherited fields.
      </div>
      <div class="cobiss-row">
        <div class="cobiss-box">
          <span class="cobiss-label">COBISS.CG-ID</span>
          <input
            :value="cobissId"
            :disabled="!editable"
            placeholder="optional — e.g. 24512006"
            @input="setCobissId(($event.target as HTMLInputElement).value)"
          />
        </div>
        <span v-if="cobissSet" class="cobiss-note">↧ Will prefill all items</span>
      </div>
    </div>

    <ParentRecordsCard
      :parents="parents"
      :editable="editable"
      :query="parentQuery"
      :results="parentResults"
      :searching="parentSearching"
      :search-error="parentSearchError"
      description="Link one or more parents. Only one passes data at a time — its shared fields copy down to the items. Click can pass data on another to switch the source."
      @update-query="setParentQuery($event)"
      @link="linkParent($event)"
      @remove="removeParent($event)"
      @toggle-pass="togglePassesData($event)"
    />

    <!-- publish + visibility -->
    <div class="two-col">
      <div class="card slim">
        <div class="heading">Publish as</div>
        <SegmentedControl
          :options="publishOptions"
          :model-value="publish"
          :disabled="!editable"
          @update:model-value="setPublish($event as 'DRAFT' | 'RECORD')"
        />
      </div>
      <div class="card slim">
        <div class="heading">Visibility</div>
        <SegmentedControl
          :options="visibilityOptions"
          :model-value="visibility"
          :disabled="!editable"
          @update:model-value="
            setVisibility($event as 'PUBLIC' | 'PRIVATE' | 'HIDDEN')
          "
        />
      </div>
    </div>

    <div v-if="editable" class="actions">
      <button class="btn-primary" :disabled="applying" @click="onContinue()">
        <span v-if="applying" class="spinner" />
        {{ applying ? "Applying defaults…" : "Next: Metadata →" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tab {
  max-width: 860px;
  margin: 0 auto;
}

.banner {
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--c-primary-soft);
  border: 1px solid var(--c-primary-soft-border);
  border-radius: 10px;
  padding: 11px 15px;
  margin-bottom: 16px;
  color: var(--c-primary);
  font-size: 13px;
}

.banner-num {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  background: var(--c-primary-soft-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 11px;
}

.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  padding: 16px 18px;
  margin-bottom: 14px;
}

.heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.slim .heading {
  margin-bottom: 10px;
}

.desc {
  font-size: 12.5px;
  color: var(--c-text-faint);
  margin-bottom: 11px;
}

.cobiss-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.cobiss-box {
  display: flex;
  align-items: center;
  background: var(--c-surface-input-alt);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  padding: 0 12px;
  height: 40px;
  flex: 1;
  max-width: 300px;
}

.cobiss-label {
  font-size: 12px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
  margin-right: 6px;
  white-space: nowrap;
}

.cobiss-box input {
  border: none;
  background: none;
  font-family: var(--font-mono);
  font-size: 14px;
  width: 100%;
}

.cobiss-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-info);
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 18px;
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.btn-primary {
  height: 42px;
  padding: 0 22px;
  border-radius: 10px;
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: default;
}

.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}
</style>
