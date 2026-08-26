//! A cheap, clonable cancel flag shared between [`crate::core::jobs`] (which
//! sets it) and [`crate::core::python`] (which polls it while a child process
//! runs). Its own leaf module because both depend on it and `jobs -> python`
//! is the existing dependency direction — putting this in either end would
//! make one of them depend upward.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
