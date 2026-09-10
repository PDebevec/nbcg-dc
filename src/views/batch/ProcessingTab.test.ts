/**
 * Render smoke tests for the Processing tab's per-step view.
 *
 * The logic lane's tests are DOM-free by design, so this deliberately does the
 * least that still proves the template works: server-render it with the
 * composable stubbed and assert the operator can actually read what the step
 * model computed. `vue-tsc` type-checks the bindings; it cannot tell you that
 * a row silently rendered nothing.
 */

import { describe, it, expect, vi } from "vitest";
import { createSSRApp, ref, computed } from "vue";
import { renderToString } from "vue/server-renderer";
import type { ProcessingItemView } from "@composables/useProcessing";
import type { StepView } from "@domain/steps";

function step(over: Partial<StepView> & { stage: StepView["stage"] }): StepView {
  return {
    stage: over.stage,
    label: over.label ?? over.stage,
    state: over.state ?? "waiting",
    detail: over.detail ?? "Not run yet.",
    error: over.error ?? null,
    action: over.action ?? null,
    progress: over.progress ?? null,
    rerunnable: over.rerunnable ?? false,
  };
}

const HELD_THUMBNAIL = step({
  stage: "thumbnail",
  label: "Thumbnail",
  state: "held",
  detail: "Held — this one needs a person.",
  action: "52 images here could be the thumbnail.",
  rerunnable: true,
});

function makeRow(over: Partial<ProcessingItemView> = {}): ProcessingItemView {
  return {
    id: "liona",
    title: "Pisma iz Liona",
    sub: "liona · 1 PDF · 52 images · supplied pdf",
    status: "done",
    statusLabel: "Done",
    error: "",
    canRerun: false,
    progress: null,
    progressLabel: "",
    gates: [],
    upload: null,
    steps: [
      step({ stage: "pdf", label: "PDF", state: "done", detail: "Web PDF built.", rerunnable: true }),
      HELD_THUMBNAIL,
      step({
        stage: "ocr",
        label: "OCR",
        state: "running",
        detail: "Recognising text… 42%",
        progress: 0.42,
        rerunnable: true,
      }),
      step({ stage: "metadata", label: "Metadata", state: "done", detail: "Required fields are complete." }),
      step({ stage: "upload", label: "Uploaded", state: "waiting", detail: "Not uploaded yet." }),
    ],
    attention: HELD_THUMBNAIL,
    completion: 0.53,
    canRerunStep: true,
    ...over,
  };
}

async function render(rows: ProcessingItemView[]): Promise<string> {
  vi.doMock("@composables/useProcessing", () => ({
    useProcessing: () => ({
      rows: computed(() => rows),
      summary: computed(() => `${rows.length} item`),
      ratio: computed(() => 0.53),
      running: computed(() => false),
      uploading: computed(() => false),
      uploadRatio: computed(() => 0),
      uploaded: computed(() => false),
      showStart: computed(() => true),
      showRerunAll: computed(() => false),
      showUpload: computed(() => false),
      canUpload: computed(() => false),
      showCancel: computed(() => false),
      blockedNote: computed(() => null),
      publishLabel: computed(() => "Draft"),
      visibilityLabel: computed(() => "Private"),
      log: ref<string[]>([]),
      start: async () => {},
      rerunItem: async () => {},
      rerunStep: async () => {},
      rerunAllFailed: async () => {},
      cancel: async () => {},
      upload: async () => {},
    }),
  }));
  vi.resetModules();
  const ProcessingTab = (await import("./ProcessingTab.vue")).default;
  return renderToString(createSSRApp(ProcessingTab, { batchId: "b1" }));
}

describe("ProcessingTab", () => {
  // The whole point of the exercise: the decision that used to be invisible.
  it("opens a row that needs a person and prints the decision in full", async () => {
    const html = await render([makeRow()]);

    expect(html).toContain("Pisma iz Liona");
    expect(html).toContain("Thumbnail");
    expect(html).toContain("52 images here could be the thumbnail.");
    expect(html).toContain("Needs you");
  });

  it("shows each step's own detail line, including the one running", async () => {
    const html = await render([makeRow()]);

    expect(html).toContain("Web PDF built.");
    expect(html).toContain("Recognising text");
    expect(html).toContain("Required fields are complete.");
  });

  it("offers a re-run on the script steps only", async () => {
    const html = await render([makeRow()]);

    // pdf (Run again), thumbnail (Run step), ocr (Run step) — never metadata
    // or upload, which are not jobs.
    expect(html.match(/class="step-btn"/g) ?? []).toHaveLength(3);
    expect(html).toContain("Run again");
    expect(html).toContain("Run step");
  });

  it("disables the per-step buttons while a batch is running", async () => {
    const html = await render([makeRow({ canRerunStep: false })]);

    expect(html).toMatch(/class="step-btn"[^>]*\sdisabled/);
    expect(html).toContain("Not while a batch is running, or after upload");
    // …and enabled when nothing is running, so the assertion above means
    // something.
    expect(await render([makeRow()])).not.toMatch(/class="step-btn"[^>]*\sdisabled/);
  });

  it("prints a failed step's error where the operator is already looking", async () => {
    const failed = makeRow({
      status: "failed",
      statusLabel: "Failed",
      steps: [
        step({
          stage: "ocr",
          label: "OCR",
          state: "failed",
          detail: "This step failed.",
          error: "ocr.py failed: paddlepaddle is not installed",
          rerunnable: true,
        }),
      ],
      attention: step({
        stage: "ocr",
        label: "OCR",
        state: "failed",
        error: "ocr.py failed: paddlepaddle is not installed",
      }),
    });
    const html = await render([failed]);

    expect(html).toContain("paddlepaddle is not installed");
    expect(html).toContain("Try again");
  });

  // A hundred-item overnight batch: the ones that are simply fine stay shut.
  it("leaves a healthy row collapsed", async () => {
    const fine = makeRow({
      attention: null,
      steps: [step({ stage: "pdf", label: "PDF", state: "done", detail: "Web PDF built.", rerunnable: true })],
    });
    const html = await render([fine]);

    expect(html).toContain("Pisma iz Liona");
    expect(html).not.toContain("Web PDF built.");
    expect(html).toContain("Expand all steps");
  });
});
