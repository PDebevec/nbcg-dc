import { describe, it, expect } from "vitest";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, type ItemStages, type StageName } from "@domain/item";
import { planPipeline } from "@domain/pipeline";
import {
  STEP_WEIGHTS,
  planSteps,
  stepNeedingAttention,
  stepProgress,
  type StepContext,
  type StepView,
} from "@domain/steps";

function asset(folderName: string, f: string): DiscoveredAsset {
  return discoverAsset(f, `/scans/${folderName}/${f}`, folderName);
}

function stagesWith(
  overrides: Partial<Record<StageName, ItemStages[StageName]>>,
): ItemStages {
  return { ...emptyStages(), ...overrides };
}

/** A plain book: a numbered page run, so all three script steps apply. */
function bookAssets(folderName = "book"): DiscoveredAsset[] {
  return ["0001.jpg", "0002.jpg", "0003.jpg"].map((f) => asset(folderName, f));
}

function context(over: Partial<StepContext> & { assets?: DiscoveredAsset[] } = {}): StepContext {
  const assets = over.assets ?? bookAssets();
  return {
    stages: over.stages ?? emptyStages(),
    plan: over.plan ?? planPipeline(assets, "book"),
    folderName: over.folderName ?? "book",
    metadataReady: over.metadataReady ?? true,
    uploaded: over.uploaded ?? false,
    needsReupload: over.needsReupload ?? false,
    live: over.live ?? null,
  };
}

function byStage(steps: StepView[], stage: StageName): StepView {
  const step = steps.find((s) => s.stage === stage);
  if (!step) throw new Error(`no ${stage} step`);
  return step;
}

describe("planSteps", () => {
  it("returns one row per pipeline stage, in run order", () => {
    const steps = planSteps(context());

    expect(steps.map((s) => s.stage)).toEqual([
      "pdf",
      "thumbnail",
      "ocr",
      "metadata",
      "upload",
    ]);
  });

  // The whole reason this module exists: `pending` covers three unrelated
  // situations and the operator was shown the same grey dot for all of them.
  describe("tells apart the three reasons a step is not done", () => {
    it("not reached yet reads `waiting`, with nothing alarming attached", () => {
      const step = byStage(planSteps(context()), "ocr");

      expect(step.state).toBe("waiting");
      expect(step.error).toBeNull();
      expect(step.action).toBeNull();
    });

    it("a failure reads `failed` and carries the error text", () => {
      const steps = planSteps(
        context({
          stages: stagesWith({ ocr: { status: "failed", error: "ocr.py exited 3" } }),
        }),
      );

      expect(byStage(steps, "ocr").state).toBe("failed");
      expect(byStage(steps, "ocr").error).toBe("ocr.py exited 3");
    });

    it("a failure with no recorded message still says something", () => {
      const steps = planSteps(
        context({ stages: stagesWith({ pdf: { status: "failed" } }) }),
      );

      expect(byStage(steps, "pdf").error).toBeTruthy();
    });

    it("a step held for a human decision reads `held` and says which decision", () => {
      // Two PDFs generate two first-page candidates and no way to rank them —
      // the native runner writes `Pending` here on purpose
      // (`settle_web_stages`). Loose images no longer reach this state: two or
      // more of them are a page-images item whose thumbnail is its first page.
      const assets = [asset("map", "a.pdf"), asset("map", "b.pdf")];
      const steps = planSteps(
        context({ assets, plan: planPipeline(assets, "map"), folderName: "map" }),
      );
      const step = byStage(steps, "thumbnail");

      expect(step.state).toBe("held");
      expect(step.action).toMatch(/thumbnail/i);
      // Names the exact file to drop in, not a vague "choose one".
      expect(step.action).toContain("map_thumb.png");
      expect(step.rerunnable).toBe(true);
    });
  });

  it("explains a step that does not apply instead of leaving it blank", () => {
    // A lone image builds no PDF - there is nothing to bind one sheet into.
    const assets = [asset("map", "veliki_zemljovid.jpg")];
    const steps = planSteps(context({ assets, plan: planPipeline(assets, "map") }));

    expect(byStage(steps, "pdf").state).toBe("skipped");
    expect(byStage(steps, "pdf").detail).toBeTruthy();
    // Nothing to re-run: the step is N/A, not merely outstanding.
    expect(byStage(steps, "pdf").rerunnable).toBe(false);
  });

  it("shows the live fraction on the step that is actually running", () => {
    const steps = planSteps(
      context({
        stages: stagesWith({ ocr: { status: "running" } }),
        live: { stage: "ocr", progress: 0.42 },
      }),
    );

    expect(byStage(steps, "ocr").progress).toBe(0.42);
    expect(byStage(steps, "ocr").detail).toContain("42%");
  });

  it("does not attribute another step's live progress to this one", () => {
    const steps = planSteps(
      context({
        stages: stagesWith({ pdf: { status: "running" } }),
        live: { stage: "ocr", progress: 0.9 },
      }),
    );

    expect(byStage(steps, "pdf").progress).toBeNull();
  });

  it("keeps metadata and upload as human steps, never re-runnable as jobs", () => {
    const steps = planSteps(context({ metadataReady: false }));

    expect(byStage(steps, "metadata").state).toBe("held");
    expect(byStage(steps, "metadata").action).toMatch(/Metadata tab/);
    expect(byStage(steps, "metadata").rerunnable).toBe(false);
    expect(byStage(steps, "upload").rerunnable).toBe(false);
  });

  it("reports a published-but-stale item as held, not done", () => {
    const steps = planSteps(context({ uploaded: true, needsReupload: true }));

    expect(byStage(steps, "upload").state).toBe("held");
    expect(byStage(steps, "upload").action).toMatch(/upload this batch again/i);
  });
});

describe("stepProgress", () => {
  it("is zero before anything runs and one when the scripts are done", () => {
    expect(stepProgress(planSteps(context()))).toBe(0);

    const done = planSteps(
      context({
        stages: stagesWith({
          pdf: { status: "done" },
          thumbnail: { status: "done" },
          ocr: { status: "done" },
        }),
      }),
    );
    expect(stepProgress(done)).toBe(1);
  });

  // The bar used to count items, so a single book sat at 0% for an hour; then
  // counting steps equally made it leap to 2/3 in the first few seconds. OCR
  // is the hour, and the weights say so.
  it("weights the steps by how long they actually take", () => {
    const built = planSteps(
      context({
        stages: stagesWith({ pdf: { status: "done" }, thumbnail: { status: "done" } }),
      }),
    );

    expect(stepProgress(built)).toBeCloseTo(STEP_WEIGHTS.pdf + STEP_WEIGHTS.thumbnail, 5);
    expect(stepProgress(built)).toBeLessThan(0.25);
  });

  it("gives the running step partial credit from its live fraction", () => {
    const half = planSteps(
      context({
        stages: stagesWith({
          pdf: { status: "done" },
          thumbnail: { status: "done" },
          ocr: { status: "running" },
        }),
        live: { stage: "ocr", progress: 0.5 },
      }),
    );

    expect(stepProgress(half)).toBeCloseTo(
      STEP_WEIGHTS.pdf + STEP_WEIGHTS.thumbnail + STEP_WEIGHTS.ocr * 0.5,
      5,
    );
  });

  it("a failed step earns no credit", () => {
    const failed = planSteps(
      context({
        stages: stagesWith({ pdf: { status: "done" }, ocr: { status: "failed" } }),
      }),
    );

    expect(stepProgress(failed)).toBeCloseTo(STEP_WEIGHTS.pdf, 5);
  });

  it("an item whose applicable steps are all done reads 100%, not 2%", () => {
    // A lone map: no PDF stage at all. Weighting against all three would peg a
    // finished map at the thumbnail's 2% forever.
    const assets = [asset("map", "veliki_zemljovid.jpg")];
    const steps = planSteps(
      context({
        assets,
        plan: planPipeline(assets, "map"),
        stages: stagesWith({
          thumbnail: { status: "done" },
          ocr: { status: "done" },
        }),
      }),
    );

    expect(stepProgress(steps)).toBe(1);
  });

  it("an empty folder is 0, never a division by zero", () => {
    const steps = planSteps(context({ assets: [], plan: planPipeline([], "nothing") }));

    expect(stepProgress(steps)).toBe(0);
  });

  it("metadata and upload do not hold the processing bar back", () => {
    const steps = planSteps(
      context({
        stages: stagesWith({
          pdf: { status: "done" },
          thumbnail: { status: "done" },
          ocr: { status: "done" },
        }),
        metadataReady: false,
        uploaded: false,
      }),
    );

    expect(stepProgress(steps)).toBe(1);
  });
});

describe("stepNeedingAttention", () => {
  it("is null while everything is simply progressing", () => {
    expect(stepNeedingAttention(planSteps(context()))).toBeNull();
  });

  it("points at a failure", () => {
    const steps = planSteps(
      context({ stages: stagesWith({ pdf: { status: "failed", error: "boom" } }) }),
    );

    expect(stepNeedingAttention(steps)?.stage).toBe("pdf");
  });

  it("points at a held step when nothing failed", () => {
    const steps = planSteps(context({ metadataReady: false }));

    expect(stepNeedingAttention(steps)?.stage).toBe("metadata");
  });

  it("prefers the failure — a broken step outranks a pending decision", () => {
    const steps = planSteps(
      context({
        stages: stagesWith({ ocr: { status: "failed", error: "boom" } }),
        metadataReady: false,
      }),
    );

    expect(stepNeedingAttention(steps)?.stage).toBe("ocr");
  });
});
