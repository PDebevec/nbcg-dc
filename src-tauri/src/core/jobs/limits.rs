//! Concurrency caps - the counting semaphore and where the limits come from.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::dto::PersistedConfig;

// ─── concurrency ──────────────────────────────────────────────────────────────

/// A cheap, hand-rolled counting semaphore — no new dependency for something
/// this small. `acquire` wakes every ~100ms (matching `core::python`'s own
/// poll cadence) rather than blocking indefinitely on a permit, so a caller
/// holding a [`SemaphoreGuard`] wait can still be interrupted by polling a
/// [`CancelToken`] between wakes instead of being stuck behind whichever
/// holder currently has the permit.
pub(super) struct Semaphore {
    available: Mutex<usize>,
    released: Condvar,
}

impl Semaphore {
    pub(super) fn new(permits: usize) -> Self {
        Self {
            available: Mutex::new(permits),
            released: Condvar::new(),
        }
    }

    /// Block until a permit is free, waking periodically so the caller can
    /// re-check a cancel token between attempts.
    pub(super) fn acquire(&self) -> SemaphoreGuard<'_> {
        let mut count = self.available.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if *count > 0 {
                *count -= 1;
                return SemaphoreGuard { sem: self };
            }
            let (guard, _timeout) = self
                .released
                .wait_timeout(count, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner());
            count = guard;
        }
    }
}

pub(super) struct SemaphoreGuard<'a> {
    sem: &'a Semaphore,
}

impl Drop for SemaphoreGuard<'_> {
    fn drop(&mut self) {
        let mut count = self.sem.available.lock().unwrap_or_else(|e| e.into_inner());
        *count += 1;
        self.sem.released.notify_one();
    }
}

/// Concurrency caps for one run, read from `config.json` at the start of each
/// run rather than passed as a command argument — see
/// `commands::config::config_save`'s preserve-on-save handling. Both fields
/// are backend-only knobs: hand-edit `config.json` to change them (the `.ts`
/// settings type doesn't carry them, and never will unless a GUI control is
/// built for open question #3 — see `docs/03-open-questions.md`).
///
/// Defaults are a first-slice guess, not measured on real volumes: OCR
/// (PaddleOCR) is the heavy stage, PDF/thumbnail assembly (Pillow/pypdfium2)
/// is comparatively light, hence the separate, tighter OCR cap.
#[derive(Debug, Clone, Copy)]
pub struct JobLimits {
    pub max_concurrent_items: usize,
    pub max_concurrent_ocr: usize,
}

impl JobLimits {
    const DEFAULT_MAX_CONCURRENT_ITEMS: usize = 3;
    /// A fat-finger guard against a hand-edited config.json forking the
    /// workstation into dozens of processes — not a product decision.
    const HARD_CEILING: usize = 8;

    /// Concurrent OCR processes, derived from the machine rather than fixed.
    ///
    /// This used to be a hardcoded `1`, which left most of a workstation idle
    /// during the one stage that actually takes hours. Per-process tuning is
    /// exhausted — `py/ocr.py` documents the thread sweep, where *more*
    /// threads per process measured strictly slower — so the only remaining
    /// way to use a big machine is to run more items at once.
    ///
    /// Measured (22 logical cores, three real pages per process, effective
    /// seconds per page across the whole cohort):
    ///
    /// | concurrent OCR | 1     | 4     | 8     |
    /// |----------------|-------|-------|-------|
    /// | s/page          | 19.00 | 7.17  | 7.00  |
    ///
    /// So it scales to about 4 and then flattens: 8 processes bought under 3%
    /// over 4 while doubling the memory.
    ///
    /// **This is now 1, and that is not a regression.** `py/ocr.py` spreads a
    /// single item's pages across worker processes itself
    /// (`nbcg_pipeline.workers`), sized from the same machine — 11 workers on
    /// this 22-core box. Running several such items at once would multiply
    /// the two caps together: 4 items x 11 workers is 44 recognition
    /// processes on 22 cores, which thrashes and would exhaust memory at
    /// ~0.5 GB each.
    ///
    /// One item at a time, using the whole machine, is both simpler and
    /// better for the operator: a book finishes in a fraction of the time
    /// instead of four books all crawling. Measured on 24 real pages,
    /// 22m27s single-process against 5m18s parallel — and that with only 3
    /// workers and a competing job. The other stages are unaffected;
    /// `max_concurrent_items` still runs several items' PDF/thumbnail work
    /// concurrently, and only OCR is gated to one.
    fn default_max_concurrent_ocr() -> usize {
        1
    }

    pub fn from_config(config: Option<&PersistedConfig>) -> Self {
        let pick = |value: Option<u32>, default: usize| -> usize {
            value
                .map(|n| n as usize)
                .filter(|&n| n > 0)
                .unwrap_or(default)
                .min(Self::HARD_CEILING)
        };
        let ocr = pick(
            config.and_then(|c| c.max_concurrent_ocr),
            Self::default_max_concurrent_ocr(),
        );
        Self {
            // An OCR permit is useless without an item slot to run it in, so
            // the item cap can never sit below the OCR cap — otherwise raising
            // OCR concurrency on a big machine would silently do nothing.
            max_concurrent_items: pick(
                config.and_then(|c| c.max_concurrent_items),
                Self::DEFAULT_MAX_CONCURRENT_ITEMS,
            )
            .max(ocr),
            max_concurrent_ocr: ocr,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::PersistedConfig;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;
    use std::thread;

    /// Deterministic, no real Python involved: spawn more workers than
    /// permits and prove the concurrent-holder count lands exactly on what was
    /// configured - never above it (the cap holds) and never below it (the
    /// semaphore doesn't over-serialize; permits > 1 really do allow real
    /// overlap). This is the property a real `core_jobs.rs` integration test
    /// can't assert without depending on actual subprocess timing, which is
    /// exactly why it's pinned here instead, against a synthetic workload.
    #[test]
    fn semaphore_never_exceeds_its_permit_count() {
        const PERMITS: usize = 2;
        // A multiple of PERMITS, so every worker finds partners at the barrier
        // and no straggler is left waiting alone for one that never comes.
        const WORKERS: usize = 6;

        let sem = Semaphore::new(PERMITS);
        let current = AtomicUsize::new(0);
        let high_water = AtomicUsize::new(0);
        // Waited on *inside* the critical section: no permit-holder may leave
        // until PERMITS of them are in there together, which is what makes the
        // overlap a fact rather than a matter of scheduling luck. Holding the
        // permit across a `sleep` instead looks equivalent but is not - a
        // worker descheduled between `acquire` and `fetch_add` lets its
        // neighbour increment, sleep, decrement and release before it ever
        // counts itself, and the high-water mark reads 1 on a loaded machine.
        let together = Barrier::new(PERMITS);

        thread::scope(|scope| {
            for _ in 0..WORKERS {
                scope.spawn(|| {
                    let _permit = sem.acquire();
                    let now = current.fetch_add(1, Ordering::SeqCst) + 1;
                    high_water.fetch_max(now, Ordering::SeqCst);
                    together.wait();
                    current.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });

        // Reaching this line at all already proves the cap is not under-used:
        // the barrier only releases once PERMITS workers hold permits at the
        // same moment. The assertion is the other half - it was never passed.
        assert_eq!(high_water.load(Ordering::SeqCst), PERMITS);
    }

    /// A released permit really does become available again - not just "the
    /// count never exceeds N" (trivially true of a semaphore that never
    /// released anything and deadlocked), but "every waiter eventually gets
    /// in". Reaching the end of this test at all is the assertion: five
    /// sequential acquires of a one-permit semaphore only succeed if each
    /// guard's `Drop` actually returned its permit.
    #[test]
    fn semaphore_permits_are_reusable() {
        let sem = Semaphore::new(1);
        for _ in 0..5 {
            let _permit = sem.acquire();
        }
    }

    /// `JobLimits::from_config` guards against the three ways a hand-edited
    /// config.json could otherwise wedge the runner: no file yet (`None`),
    /// an explicit `0` (would deadlock every worker/OCR wait forever), and
    /// an implausibly large number (a typo shouldn't fork the workstation
    /// into dozens of processes).
    #[test]
    fn job_limits_from_config_defaults_and_clamps() {
        let defaults = JobLimits::from_config(None);
        assert!(
            defaults.max_concurrent_items >= JobLimits::DEFAULT_MAX_CONCURRENT_ITEMS,
            "the item cap must never drop below its own default"
        );
        // Derived from the machine now, not a constant. Assert the contract
        // rather than a number: at least one, never more than the measured
        // plateau of 4, and never more than the item cap can actually run.
        assert!(
            (1..=4).contains(&defaults.max_concurrent_ocr),
            "derived OCR cap out of range: {}",
            defaults.max_concurrent_ocr
        );
        assert!(
            defaults.max_concurrent_items >= defaults.max_concurrent_ocr,
            "an OCR permit is useless without an item slot to run it in"
        );

        let zeroed = JobLimits::from_config(Some(&PersistedConfig {
            max_concurrent_items: Some(0),
            max_concurrent_ocr: Some(0),
            ..Default::default()
        }));
        assert_eq!(
            zeroed.max_concurrent_items,
            JobLimits::DEFAULT_MAX_CONCURRENT_ITEMS.max(JobLimits::default_max_concurrent_ocr())
        );
        assert_eq!(
            zeroed.max_concurrent_ocr,
            JobLimits::default_max_concurrent_ocr(),
            "a zeroed config falls back to the derived default, not to zero"
        );

        let huge = JobLimits::from_config(Some(&PersistedConfig {
            max_concurrent_items: Some(500),
            max_concurrent_ocr: Some(500),
            ..Default::default()
        }));
        assert_eq!(huge.max_concurrent_items, JobLimits::HARD_CEILING);
        assert_eq!(huge.max_concurrent_ocr, JobLimits::HARD_CEILING);

        let reasonable = JobLimits::from_config(Some(&PersistedConfig {
            max_concurrent_items: Some(4),
            max_concurrent_ocr: Some(2),
            ..Default::default()
        }));
        assert_eq!(reasonable.max_concurrent_items, 4);
        assert_eq!(reasonable.max_concurrent_ocr, 2);

        // An explicit OCR cap above the item cap raises the item cap with it,
        // rather than silently running fewer OCR processes than asked for.
        let ocr_heavy = JobLimits::from_config(Some(&PersistedConfig {
            max_concurrent_items: Some(1),
            max_concurrent_ocr: Some(4),
            ..Default::default()
        }));
        assert_eq!(ocr_heavy.max_concurrent_ocr, 4);
        assert_eq!(ocr_heavy.max_concurrent_items, 4);
    }
}
