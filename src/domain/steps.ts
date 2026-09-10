/**
 * The **per-step view** of one item's pipeline (Epic 06 — Processing tab).
 *
 * The Overview's stage pips answer "is this stage done?" in one dot. That is
 * enough for a table of two hundred rows and not enough for the operator
 * actually running a batch, who needs to know *why* a step is not done and
 * what to do about it. A grey dot today covers three completely different
 * situations:
 *
 *  - **not run yet** — nothing is wrong, the step simply has not executed;
 *  - **failed** — it ran and errored, and the error text is the whole point;
 *  - **held for a human** — the pipeline deliberately stopped short because a
 *    person has to decide something (which image is the thumbnail, what the
 *    required metadata says).
 *
 * The third is the one that cost a real afternoon: a `supplied-pdf` item with
 * 53 loose page images finished with `pdf → done`, `ocr → done`,
 * `thumbnail → pending`, and the only sentence the operator ever saw was
 * *"Not fully processed yet (thumbnail)."* — at upload time, with no hint that
 * the fix is to run one step (see `settle_web_stages` in
 * `src-tauri/src/core/jobs/mod.rs`, which holds the stage at `Pending` on
 * purpose when `thumbnail_needs_choice`).
 *
 * Framework-free and pure, like its sibling domain modules: it takes an item's
 * recorded stage map plus its {@link PipelinePlan} and returns rows to render.
 */

import { STAGE_LABELS, STAGE_NAMES, type ItemStages, type StageName } from "./item";
import type { PipelinePlan, RunnableStage } from "./pipeline";

/**
 * What one step is doing, from the operator's point of view.
 *
 * Deliberately *not* {@link StageStatus}: `pending` there conflates "not
 * reached" with "held for a decision", which is the distinction this whole
 * module exists to make.
 */
export type StepState =
  | "done"
  | "running"
  | "queued"
  | "failed"
  /** Stopped short until a person decides something — {@link StepView.action}
   * says what. */
  | "held"
  /** Not run yet. Nothing is wrong. */
  | "waiting"
  /** Not applicable to this item at all (e.g. OCR on an image-only folder). */
  | "skipped";

/** One row of the expanded per-item step list. */
export interface StepView {
  stage: StageName;
  label: string;
  state: StepState;
  /** One line of plain language: what happened, or what is happening. */
  detail: string;
  /** The failure text, on a `failed` step — never truncated here, the view
   * decides how much to show. */
  error: string | null;
  /** What the operator has to do, on a `held` step. Null everywhere else. */
  action: string | null;
  /** Live fraction (0–1) while `running`, else null. */
  progress: number | null;
  /** Whether this step can be re-run on its own (the three script stages;
   * metadata and upload are not jobs). */
  rerunnable: boolean;
}

/** Everything {@link planSteps} needs about one item. */
export interface StepContext {
  stages: ItemStages;
  plan: PipelinePlan;
  /** The item's folder name — the derived-output naming base, so a message
   * can name the exact file the operator would drop in. */
  folderName: string;
  /** Whether the item's required metadata validates (Epic 04). */
  metadataReady: boolean;
  /** Published to the backend at least once. */
  uploaded: boolean;
  /** Published, but derived files changed since. */
  needsReupload: boolean;
  /** The live `job://progress` feed for this item, when a step is running. */
  live: { stage: RunnableStage; progress: number | null } | null;
}

/**
 * Roughly how much of an item's processing time each step is, used **only** to
 * weight the progress bar.
 *
 * Not guessed: OCR is minutes per page (5m18s for 24 pages even after the
 * parallel rewrite — see `docs/tasks/06-processing-pipeline-and-jobs.md`),
 * the PDF build is tens of seconds, and the thumbnail is one page render.
 * Counting the three equally made the bar leap to two thirds in the first
 * few seconds and then sit still for an hour, which is exactly the
 * imprecision the operator asked to have fixed.
 */
export const STEP_WEIGHTS: Record<RunnableStage, number> = {
  pdf: 0.18,
  thumbnail: 0.02,
  ocr: 0.8,
};

function isRunnable(stage: StageName): stage is RunnableStage {
  return stage in STEP_WEIGHTS;
}

/** Present-tense copy for a running step. */
const RUNNING_COPY: Record<RunnableStage, string> = {
  pdf: "Building the PDF",
  thumbnail: "Rendering the thumbnail",
  ocr: "Recognising text",
};

/** Past-tense copy for a completed step. */
const DONE_COPY: Record<RunnableStage, string> = {
  pdf: "Web PDF built.",
  thumbnail: "Thumbnail written.",
  ocr: "Full text recognised.",
};

/** Why a step does not apply to this item — an explanation, not a blank. */
function skipCopy(stage: RunnableStage, plan: PipelinePlan): string {
  if (plan.inputShape === "empty") {
    return "Nothing in this folder to process.";
  }
  switch (stage) {
    case "pdf":
      return "No PDF is built for a standalone image — the images are the web files.";
    case "ocr":
      return "No full text for a standalone image — nothing to recognise.";
    case "thumbnail":
      return "Not applicable to this item.";
  }
}

/**
 * The decision holding a step, if one is. Today the only step the pipeline
 * stops short on is the thumbnail; keeping this a lookup rather than an
 * `if` means adding the next one is a case, not a rewrite.
 */
function holdFor(stage: RunnableStage, ctx: StepContext): string | null {
  const { plan } = ctx;
  if (stage === "thumbnail" && plan.thumbnail.needsChoice) {
    // Two ways out, and the operator should be told both. Running the step
    // renders a default (the first page) and writes it as `<name>_thumb.png`,
    // which is itself a pre-tagged candidate — so the *next* pass has an
    // unambiguous pick and settles the stage. Dropping in your own file first
    // does the same thing with your image instead of theirs.
    return (
      `${plan.thumbnail.candidateCount} images here could be the thumbnail, so none ` +
      `is chosen for you. Run this step to use the first page, or put the image ` +
      `you want in the folder as ${thumbnailName(ctx.folderName)} first.`
    );
  }
  return null;
}

/** The derived thumbnail's filename, matching `core::fs`'s naming. */
function thumbnailName(folderName: string): string {
  return `${folderName}_thumb.png`;
}

function runnableStep(stage: RunnableStage, ctx: StepContext): StepView {
  const label = STAGE_LABELS[stage];
  const base = { stage, label, error: null, action: null, progress: null, rerunnable: true };

  if (!ctx.plan.stages[stage]) {
    return { ...base, state: "skipped", detail: skipCopy(stage, ctx.plan), rerunnable: false };
  }

  const outcome = ctx.stages[stage];
  switch (outcome.status) {
    case "done":
      return { ...base, state: "done", detail: DONE_COPY[stage] };

    case "failed":
      return {
        ...base,
        state: "failed",
        detail: "This step failed. Fix the cause, then run it again.",
        error: outcome.error ?? "No error detail was recorded.",
      };

    case "running": {
      const progress = ctx.live?.stage === stage ? ctx.live.progress : null;
      const pct = progress == null ? "" : ` — ${Math.round(progress * 100)}%`;
      return { ...base, state: "running", detail: `${RUNNING_COPY[stage]}…${pct}`, progress };
    }

    case "queued":
      return { ...base, state: "queued", detail: "Waiting for the steps before it." };

    // `pending` from the index, and `skipped` recorded natively for a stage the
    // runner found inapplicable — both mean "no result", so the plan above is
    // what decides whether that is a hold or simply not run yet.
    case "pending":
    case "skipped": {
      const action = holdFor(stage, ctx);
      if (action) {
        return {
          ...base,
          state: "held",
          detail: "Held — this one needs a person.",
          action,
        };
      }
      return { ...base, state: "waiting", detail: "Not run yet." };
    }
  }
}

/** Metadata is never a job — it is done when the fields validate. */
function metadataStep(ctx: StepContext): StepView {
  const base = {
    stage: "metadata" as const,
    label: STAGE_LABELS.metadata,
    error: null,
    progress: null,
    rerunnable: false,
  };
  if (ctx.metadataReady) {
    return { ...base, state: "done", detail: "Required fields are complete.", action: null };
  }
  return {
    ...base,
    state: "held",
    detail: "Held — this one needs a person.",
    action: "Required metadata is missing or invalid. Fill it in on the Metadata tab.",
  };
}

/** Upload is a separate, deliberate operator step (docs/tasks/07). */
function uploadStep(ctx: StepContext): StepView {
  const base = {
    stage: "upload" as const,
    label: STAGE_LABELS.upload,
    error: null,
    progress: null,
    rerunnable: false,
  };
  if (ctx.uploaded && ctx.needsReupload) {
    return {
      ...base,
      state: "held",
      detail: "Published, but out of date.",
      action: "Derived files changed since the last upload — upload this batch again.",
    };
  }
  if (ctx.uploaded) {
    return { ...base, state: "done", detail: "Published to the backend.", action: null };
  }
  return { ...base, state: "waiting", detail: "Not uploaded yet.", action: null };
}

/** The five pipeline steps for one item, in run order. */
export function planSteps(ctx: StepContext): StepView[] {
  return STAGE_NAMES.map((stage) => {
    if (isRunnable(stage)) return runnableStep(stage, ctx);
    return stage === "metadata" ? metadataStep(ctx) : uploadStep(ctx);
  });
}

/**
 * How far this item's **processing** has actually got, 0–1, weighted by
 * {@link STEP_WEIGHTS} and given partial credit for the step now running.
 *
 * Counts only the three script steps: metadata and upload are the operator's
 * own work and have their own controls, so folding them in would make the
 * processing bar stall at 60% on a finished item.
 *
 * Steps that do not apply carry no weight at all, so an image-only item
 * (thumbnail only) still reaches 1.
 */
export function stepProgress(steps: StepView[]): number {
  let total = 0;
  let complete = 0;
  for (const step of steps) {
    if (!isRunnable(step.stage) || step.state === "skipped") continue;
    const weight = STEP_WEIGHTS[step.stage];
    total += weight;
    if (step.state === "done") complete += weight;
    else if (step.state === "running") complete += weight * (step.progress ?? 0);
  }
  return total === 0 ? 0 : complete / total;
}

/**
 * The one step the operator should look at, if any: a failure first (something
 * is broken), then a step held for a decision (something is waiting on them).
 *
 * Drives the collapsed row's note and which rows open by default — the point
 * being that a person scanning a hundred-item batch should not have to expand
 * each one to find the two that need them.
 */
export function stepNeedingAttention(steps: StepView[]): StepView | null {
  return (
    steps.find((s) => s.state === "failed") ?? steps.find((s) => s.state === "held") ?? null
  );
}
