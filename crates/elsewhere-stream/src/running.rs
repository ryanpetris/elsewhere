//! Joined, cancellable media workers shared by native audio and webcam output.
use anyhow::{Result, bail};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

/// A running audio or webcam stream. Dropping it stops and joins its workers.
pub struct Running {
    stop: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Running {
    pub(crate) fn spawn(name: &str, work: impl FnOnce(Arc<AtomicBool>) -> Result<()> + Send + 'static) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let stopped = stop.clone();
        let failure = error.clone();
        let name = name.to_owned();
        let thread = std::thread::Builder::new().name(name.clone()).spawn(move || {
            let result = work(stopped.clone());
            tracing::debug!(worker = name, stopping = stopped.load(Ordering::Relaxed), error = ?result.as_ref().err(), "media worker exited");
            if !stopped.load(Ordering::Relaxed) {
                let message = match result { Ok(()) => format!("{name} ended"), Err(error) => format!("{name}: {error:#}") };
                tracing::warn!("{message}");
                *failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(message);
            }
        })?;
        Ok(Self { stop, error, thread: Some(thread) })
    }

    pub fn check(&self) -> Result<()> {
        if let Some(error) = self.error.lock().unwrap_or_else(|p| p.into_inner()).as_ref() { bail!("{error}"); }
        if self.thread.as_ref().is_some_and(|thread| thread.is_finished()) { bail!("media worker ended"); }
        Ok(())
    }

    pub fn stop(&self) { self.stop.store(true, Ordering::Relaxed); }

    pub fn join(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

impl Drop for Running {
    fn drop(&mut self) { self.join(); }
}
