//! Sync-run history.

mod common;

use common::*;
use nbcg_dc_lib::core::db::{sync_runs, Db, SYNC_RUN_HISTORY_LIMIT};
use nbcg_dc_lib::dto::*;

#[test]
fn append_assigns_an_id_and_returns_the_stored_row() {
    let db = Db::open_in_memory().unwrap();
    let stored = db
        .transaction(|t| sync_runs::append(t, &sync_run("2 missed", "2026-08-12T09:00:00.000Z")))
        .unwrap();

    assert!(!stored.id.is_empty());
    assert_eq!(stored.summary, "2 missed");
    assert_eq!(stored.checked, 4);
    assert_eq!(stored.status, SyncRunStatus::Ok);
    assert_eq!(stored.trigger, SyncTrigger::Manual);
}

#[test]
fn list_returns_newest_first() {
    let db = Db::open_in_memory().unwrap();
    for (summary, at) in [
        ("oldest", "2026-08-10T09:00:00.000Z"),
        ("middle", "2026-08-11T09:00:00.000Z"),
        ("newest", "2026-08-12T09:00:00.000Z"),
    ] {
        db.transaction(|t| sync_runs::append(t, &sync_run(summary, at)))
            .unwrap();
    }

    let all = db.with(|c| sync_runs::list(c, None)).unwrap();
    let summaries: Vec<&str> = all.iter().map(|r| r.summary.as_str()).collect();
    assert_eq!(summaries, vec!["newest", "middle", "oldest"]);
}

#[test]
fn list_honours_a_limit() {
    let db = Db::open_in_memory().unwrap();
    for i in 0..5 {
        db.transaction(|t| {
            sync_runs::append(
                t,
                &sync_run(&format!("run {i}"), &format!("2026-08-1{i}T09:00:00.000Z")),
            )
        })
        .unwrap();
    }

    assert_eq!(db.with(|c| sync_runs::list(c, Some(2))).unwrap().len(), 2);
}

#[test]
fn a_nonsense_limit_falls_back_to_the_retention_cap() {
    let db = Db::open_in_memory().unwrap();
    db.transaction(|t| sync_runs::append(t, &sync_run("only", "2026-08-12T09:00:00.000Z")))
        .unwrap();

    // Zero and negative limits must not silently return nothing.
    assert_eq!(db.with(|c| sync_runs::list(c, Some(0))).unwrap().len(), 1);
    assert_eq!(db.with(|c| sync_runs::list(c, Some(-5))).unwrap().len(), 1);
}

#[test]
fn history_is_capped_on_append() {
    let db = Db::open_in_memory().unwrap();
    let over = SYNC_RUN_HISTORY_LIMIT + 10;

    for i in 0..over {
        // Timestamps ascend, so the *oldest* are the ones that must be pruned.
        let at = format!("2026-08-12T09:{:02}:{:02}.000Z", i / 60, i % 60);
        db.transaction(|t| sync_runs::append(t, &sync_run(&format!("run {i}"), &at)))
            .unwrap();
    }

    let all = db.with(|c| sync_runs::list(c, None)).unwrap();
    assert_eq!(all.len() as i64, SYNC_RUN_HISTORY_LIMIT);
    assert_eq!(all[0].summary, format!("run {}", over - 1));
}

#[test]
fn an_empty_history_lists_nothing() {
    let db = Db::open_in_memory().unwrap();
    assert!(db.with(|c| sync_runs::list(c, None)).unwrap().is_empty());
}
