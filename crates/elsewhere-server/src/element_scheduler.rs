//! Shared observations and fair admission for accessibility work.
use std::{collections::{HashMap, VecDeque}, sync::{Arc, Mutex, OnceLock, Weak}, time::Duration};
use tokio::{sync::{mpsc, oneshot, Notify}, task::JoinSet};
use crate::{App, Key, api::ApiError, elements::{self, Element, Page}};
use elsewhere_core::WindowInfo;

const INTERVAL: Duration = Duration::from_millis(100);
const SCANS: usize = 8;
const REFRESHES: usize = 4;
const MUTATIONS: usize = 4;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum Application { Process(u32), Window(u64) }
impl Application {
    pub fn of(window: &WindowInfo) -> Self { window.pid.map(Self::Process).unwrap_or(Self::Window(window.id)) }
}

pub(crate) struct Observation {
    pub window: WindowInfo,
    pub page: Page,
    refreshed: Mutex<HashMap<String, Arc<Refresh>>>,
}
pub(crate) struct Refresh {
    id: uuid::Uuid,
    result: OnceLock<Result<Element, ApiError>>,
}
impl Observation {
    pub fn reference(&self, reference: &str) -> Arc<Refresh> {
        self.refreshed.lock().unwrap().entry(reference.into()).or_insert_with(|| Arc::new(Refresh {
            id: uuid::Uuid::new_v4(), result: OnceLock::new(),
        })).clone()
    }
}

#[derive(Clone)]
enum Value { Scan(Arc<Observation>), Refresh(Element) }
type Outcome = Result<Value, ApiError>;
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum JobId { Scan(u64), Refresh(uuid::Uuid) }
#[derive(Clone)]
enum Work { Scan(u64), Refresh(Arc<Refresh>, Element) }
struct Reader { key: Key, reply: oneshot::Sender<Outcome> }
impl Reader { fn live(&self) -> bool { self.key.live() && !self.reply.is_closed() } }
struct Job { application: Application, work: Work, readers: Vec<Reader> }
impl Job { fn prune(&mut self) { self.readers.retain(Reader::live); } }

/// Dropping the lease wakes admission after releasing the application's slot.
pub(crate) struct Permit { lease: Option<Arc<()>>, wake: Arc<Notify> }
impl Drop for Permit {
    fn drop(&mut self) { self.lease.take(); self.wake.notify_one(); }
}
struct Admission { key: Key, application: Application, reply: oneshot::Sender<Permit> }
#[derive(Default)]
struct Admissions {
    active: HashMap<Application, Weak<()>>,
    tokens: VecDeque<uuid::Uuid>,
    pending: HashMap<uuid::Uuid, VecDeque<Admission>>,
}
impl Admissions {
    fn push(&mut self, request: Admission) {
        let token = request.key.metadata.id;
        self.pending.entry(token).or_insert_with(|| { self.tokens.push_back(token); VecDeque::new() }).push_back(request);
    }
    fn dispatch(&mut self, wake: &Arc<Notify>) {
        self.active.retain(|_, lease| lease.strong_count() > 0);
        self.pending.retain(|_, queue| { queue.retain(|r| r.key.live() && !r.reply.is_closed()); !queue.is_empty() });
        self.tokens.retain(|token| self.pending.contains_key(token));
        while self.active.len() < MUTATIONS {
            let mut next = None;
            for _ in 0..self.tokens.len() {
                let token = self.tokens.pop_front().unwrap();
                self.tokens.push_back(token);
                let queue = &mut self.pending.get_mut(&token).unwrap();
                if let Some(index) = queue.iter().position(|r| !self.active.contains_key(&r.application)) {
                    next = queue.remove(index);
                    if queue.is_empty() { self.pending.remove(&token); self.tokens.retain(|id| *id != token); }
                    break;
                }
            }
            let Some(request) = next else { break; };
            let lease = Arc::new(());
            self.active.insert(request.application, Arc::downgrade(&lease));
            let _ = request.reply.send(Permit { lease: Some(lease), wake: wake.clone() });
        }
    }
}

enum Request {
    Observe { id: JobId, application: Application, work: Work, reader: Reader },
    Mutate(Admission),
}
pub(crate) struct Scheduler { requests: mpsc::UnboundedSender<Request>, started: tokio::time::Instant }
impl Scheduler {
    pub fn start(app: Weak<App>) -> Self {
        let (requests, receiver) = mpsc::unbounded_channel();
        tokio::spawn(run(receiver, move |work| {
            let app = app.clone();
            async move {
                match work {
                    Work::Scan(window) => {
                        let app = app.upgrade().ok_or_else(stopped)?;
                        app.element_scan(window).await.map(|(window, page)| Value::Scan(Arc::new(Observation { window, page, refreshed: Mutex::default() })))
                    },
                    Work::Refresh(_, element) => {
                        // Queued revalidation retains target metadata, not an open bus connection.
                        let refresh = async {
                            let conn = elements::a11y_bus().await.map_err(|e| elements::error("bus_unavailable", format!("{e:#}")))?;
                            elements::refresh(&conn, &element).await.map(Value::Refresh)
                        };
                        tokio::time::timeout(Duration::from_secs(5), refresh).await
                            .map_err(|_| elements::error("tree_timeout", "target revalidation exceeded five seconds"))?
                    },
                }
            }
        }));
        Self { requests, started: tokio::time::Instant::now() }
    }
    pub fn next_poll(&self) -> tokio::time::Instant {
        let now = tokio::time::Instant::now();
        let remaining = INTERVAL.as_nanos() - now.duration_since(self.started).as_nanos() % INTERVAL.as_nanos();
        now + Duration::from_nanos(remaining as u64)
    }
    pub async fn scan(&self, key: &Key, window: u64, application: Application) -> Result<Arc<Observation>, ApiError> {
        let (reply, result) = oneshot::channel();
        self.requests.send(Request::Observe { id: JobId::Scan(window), application, work: Work::Scan(window), reader: Reader { key: key.clone(), reply } }).map_err(|_| stopped())?;
        match receive(key, result).await?? { Value::Scan(page) => Ok(page), _ => unreachable!() }
    }
    pub async fn refresh(&self, key: &Key, application: Application, cell: Arc<Refresh>, element: Element) -> Result<Element, ApiError> {
        if !key.live() { return Err(ApiError::Unauthorized); }
        if let Some(result) = cell.result.get() { return result.clone(); }
        let (reply, result) = oneshot::channel();
        self.requests.send(Request::Observe { id: JobId::Refresh(cell.id), application, work: Work::Refresh(cell, element), reader: Reader { key: key.clone(), reply } }).map_err(|_| stopped())?;
        match receive(key, result).await?? { Value::Refresh(element) => Ok(element), _ => unreachable!() }
    }
    pub async fn mutation(&self, key: &Key, application: Application) -> Result<Permit, ApiError> {
        let (reply, result) = oneshot::channel();
        self.requests.send(Request::Mutate(Admission { key: key.clone(), application, reply })).map_err(|_| stopped())?;
        receive(key, result).await
    }
}

async fn receive<T>(key: &Key, result: oneshot::Receiver<T>) -> Result<T, ApiError> {
    tokio::select! { biased;
        _ = key.ended() => Err(ApiError::Unauthorized),
        result = result => {
            // Wall-clock expiry may precede the Tokio expiry timer's wakeup.
            if !key.live() { Err(ApiError::Unauthorized) } else { result.map_err(|_| stopped()) }
        },
    }
}
fn stopped() -> ApiError { ApiError::Unavailable("accessibility scheduler stopped".into()) }

#[derive(Default)]
struct Jobs {
    queued: HashMap<JobId, Job>,
    order: VecDeque<JobId>,
    tokens: VecDeque<uuid::Uuid>,
    active: HashMap<JobId, (Job, tokio::task::AbortHandle)>,
}
impl Jobs {
    fn push(&mut self, id: JobId, application: Application, work: Work, reader: Reader) {
        if let Work::Refresh(cell, _) = &work {
            if let Some(result) = cell.result.get() { let _ = reader.reply.send(result.clone().map(Value::Refresh)); return; }
            if let Some((job, task)) = self.active.get_mut(&id) {
                if !task.is_finished() && !job.readers.is_empty() { job.readers.push(reader); return; }
            }
        }
        // Scans always start after their readers arrive. Refreshes share the same observation.
        let token = reader.key.metadata.id;
        if !self.tokens.contains(&token) { self.tokens.push_back(token); }
        self.queued.entry(id).or_insert_with(|| {
            self.order.push_back(id);
            Job { application, work, readers: Vec::new() }
        }).readers.push(reader);
    }
    fn prune(&mut self) {
        for (job, task) in self.active.values_mut() { job.prune(); if job.readers.is_empty() { task.abort(); } }
        self.queued.retain(|_, job| { job.prune(); !job.readers.is_empty() });
        self.order.retain(|id| self.queued.contains_key(id));
        self.tokens.retain(|token| self.queued.values().any(|job| job.readers.iter().any(|r| r.key.metadata.id == *token)));
    }
    fn next(&mut self) -> Option<(JobId, Job)> {
        for _ in 0..self.tokens.len() {
            let token = self.tokens.pop_front().unwrap();
            self.tokens.push_back(token);
            let next = self.order.iter().position(|id| {
                let job = &self.queued[id];
                let scan = matches!(id, JobId::Scan(_));
                let same_kind = |other: &JobId| matches!(other, JobId::Scan(_)) == scan;
                !self.active.contains_key(id)
                    && self.active.keys().filter(|id| same_kind(id)).count() < if scan { SCANS } else { REFRESHES }
                    && self.active.iter().filter(|(id, (active, _))| same_kind(id) && active.application == job.application).count() < if scan { 2 } else { 1 }
                    && job.readers.iter().any(|r| r.key.metadata.id == token)
            });
            if let Some(index) = next {
                let id = self.order.remove(index).unwrap();
                return Some((id, self.queued.remove(&id).unwrap()));
            }
        }
        None
    }
    fn finish(&mut self, id: JobId, result: Outcome) {
        if let Some((job, _)) = self.active.remove(&id) {
            if let Work::Refresh(cell, _) = &job.work {
                let _ = cell.result.set(result.clone().map(|value| match value { Value::Refresh(element) => element, _ => unreachable!() }));
                // Registrations arriving just as the worker finished use the same result.
                if let Some(queued) = self.queued.remove(&id) {
                    for reader in queued.readers { let _ = reader.reply.send(result.clone()); }
                }
            }
            for reader in job.readers { let _ = reader.reply.send(result.clone()); }
        }
    }
}

async fn run<F: std::future::Future<Output = Outcome> + Send + 'static>(mut requests: mpsc::UnboundedReceiver<Request>, work: impl Fn(Work) -> F) {
    let mut jobs = Jobs::default();
    let mut tasks: JoinSet<(JobId, Outcome)> = JoinSet::new();
    let mut mutations = Admissions::default();
    let wake = Arc::new(Notify::new());
    let mut tick = tokio::time::interval(INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let accept = |request, jobs: &mut Jobs, mutations: &mut Admissions| match request {
        Request::Observe { id, application, work, reader } => jobs.push(id, application, work, reader),
        Request::Mutate(request) => mutations.push(request),
    };
    loop {
        tokio::select! {
            request = requests.recv() => match request { Some(request) => accept(request, &mut jobs, &mut mutations), None => break },
            result = tasks.join_next(), if !tasks.is_empty() => match result {
                Some(Ok((id, result))) => jobs.finish(id, result),
                Some(Err(error)) => {
                    let id = jobs.active.iter().find_map(|(id, (_, task))| (task.id() == error.id()).then_some(*id));
                    if let Some(id) = id { jobs.active.remove(&id); }
                },
                None => {},
            },
            _ = wake.notified() => {},
            _ = tick.tick(), if !jobs.queued.is_empty() || !jobs.active.is_empty() || !mutations.pending.is_empty() => {},
        }
        // Coalesce ready requests while keeping a continuous producer from delaying completions.
        // This is a work slice, not a limit on the number of queued requests.
        tokio::task::yield_now().await;
        for _ in 0..256 {
            match requests.try_recv() { Ok(request) => accept(request, &mut jobs, &mut mutations), Err(_) => break }
        }
        jobs.prune();
        mutations.dispatch(&wake);
        while let Some((id, job)) = jobs.next() {
            let future = work(job.work.clone());
            let task = tasks.spawn(async move { (id, future.await) });
            jobs.active.insert(id, (job, task));
        }
    }
}

impl App {
    pub(crate) fn element_scheduler(self: &Arc<Self>) -> &Scheduler {
        self.element_scheduler.get_or_init(|| Scheduler::start(Arc::downgrade(self)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key() -> Key { key_expiring(None) }
    fn key_expiring(expires_at_ms: Option<i64>) -> Key {
        Arc::new(crate::auth::Access::new(crate::tokens::Token {
            id: uuid::Uuid::new_v4(), label: "Scheduler check".into(), created_at_ms: 0,
            expires_at_ms, permissions: [crate::tokens::Permission::DesktopView].into(),
        }))
    }
    fn read(sender: &mpsc::UnboundedSender<Request>, key: &Key, window: u64, application: Application) -> oneshot::Receiver<Outcome> {
        let (reply, result) = oneshot::channel();
        sender.send(Request::Observe { id: JobId::Scan(window), application, work: Work::Scan(window), reader: Reader { key: key.clone(), reply } }).unwrap();
        result
    }
    async fn settle() { for _ in 0..100 { tokio::task::yield_now().await; } }
    async fn prune() { tokio::time::advance(INTERVAL).await; settle().await; }

    #[tokio::test(start_paused = true)]
    async fn shared_scans_are_fresh_bounded_and_isolate_applications() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (started, mut starts) = mpsc::unbounded_channel();
        let scheduler = tokio::spawn(run(receiver, move |work| {
            let Work::Scan(window) = work else { unreachable!() };
            let (finish, result) = oneshot::channel::<()>();
            started.send((window, finish)).unwrap();
            async move { let _ = result.await; Err(elements::error("missing", "fixture observation")) }
        }));
        let token = key();
        let before = tokio::time::Instant::now();
        let mut readers: Vec<_> = (0..64).map(|_| read(&sender, &token, 1, Application::Process(1))).collect();
        settle().await;
        let (window, finish) = starts.try_recv().unwrap();
        assert_eq!(window, 1);
        assert!(starts.try_recv().is_err(), "one scan serves the batch");
        assert_eq!(before, tokio::time::Instant::now(), "idle admission does not wait for a tick");
        let mut fresh = read(&sender, &token, 1, Application::Process(1));
        settle().await;
        assert!(starts.try_recv().is_err(), "no overlapping scan for the same window");
        finish.send(()).unwrap();
        settle().await;
        for result in &mut readers { assert!(result.try_recv().unwrap().is_err()); }
        assert!(fresh.try_recv().is_err(), "a later read cannot consume an earlier observation");
        let (_, abandoned) = starts.try_recv().unwrap();
        drop(fresh);
        prune().await;
        assert!(abandoned.is_closed());
        let blocked: Vec<_> = (0..20).map(|window| read(&sender, &token, window, Application::Process(1))).collect();
        let healthy = read(&sender, &key(), 99, Application::Process(2));
        settle().await;
        let mut active = Vec::new();
        while let Ok(scan) = starts.try_recv() { active.push(scan); }
        assert_eq!(active.iter().map(|(window, _)| *window).collect::<Vec<_>>(), vec![0, 99, 1], "siblings can progress without one application's stalled windows taking every scan slot");
        drop(blocked); drop(healthy);
        prune().await;
        assert!(active.iter().all(|(_, finish)| finish.is_closed()));
        let readers: Vec<_> = (0..20).map(|window| read(&sender, &token, window, Application::Window(window))).collect();
        settle().await;
        let mut active = Vec::new();
        while let Ok(scan) = starts.try_recv() { active.push(scan); }
        assert_eq!(active.len(), SCANS);
        for (_, finish) in active { finish.send(()).unwrap(); }
        settle().await;
        let mut active = Vec::new();
        while let Ok(scan) = starts.try_recv() { active.push(scan); }
        assert_eq!(active.iter().map(|(window, _)| *window).collect::<Vec<_>>(), (8..16).collect::<Vec<_>>());
        drop(readers); prune().await; drop(sender); scheduler.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn mutations_serialize_per_application_and_release_without_tick_delay() {
        let (requests, receiver) = mpsc::unbounded_channel();
        let scheduler_task = tokio::spawn(run(receiver, |_| std::future::pending::<Outcome>()));
        let scheduler = Scheduler { requests, started: tokio::time::Instant::now() };
        let first = key(); let second = key();
        let held = scheduler.mutation(&first, Application::Process(1)).await.unwrap();
        let mut queued = Box::pin(scheduler.mutation(&first, Application::Process(1)));
        assert!(futures_util::poll!(&mut queued).is_pending());
        let healthy = scheduler.mutation(&second, Application::Process(2)).await.unwrap();
        let mut competitor = Box::pin(scheduler.mutation(&second, Application::Process(1)));
        assert!(futures_util::poll!(&mut competitor).is_pending());
        settle().await;
        assert!(futures_util::poll!(&mut queued).is_pending());
        let before = tokio::time::Instant::now();
        drop(held);
        settle().await;
        let next = queued.await.unwrap();
        drop(next);
        settle().await;
        drop(competitor.await.unwrap());
        assert_eq!(before, tokio::time::Instant::now(), "released capacity is reused immediately");
        drop(healthy); drop(scheduler); scheduler_task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn wall_clock_expiry_wins_over_a_pending_timer_and_closed_or_ready_reply() {
        for send in [false, true] {
            let key = key_expiring(Some(crate::tokens::now_ms() + 20));
            let (reply, result) = oneshot::channel();
            let mut waiting = Box::pin(receive(&key, result));
            assert!(futures_util::poll!(&mut waiting).is_pending());
            // Keep Tokio time paused while the authoritative wall clock passes expiry.
            std::thread::sleep(Duration::from_millis(25));
            if send { reply.send(()).unwrap(); } else { drop(reply); }
            assert!(matches!(futures_util::poll!(&mut waiting), std::task::Poll::Ready(Err(ApiError::Unauthorized))));
        }
    }

    fn element() -> Element {
        Element { reference: None, enabled: Some(false), focused: None, checked: None, editable: None,
            actions: None, bounds_available: false, target: None, role: "button", name: "Fixture".into(), x: 0, y: 0, w: 0, h: 0 }
    }
    fn refresh(sender: &mpsc::UnboundedSender<Request>, key: &Key, cell: &Arc<Refresh>) -> oneshot::Receiver<Outcome> {
        let (reply, result) = oneshot::channel();
        sender.send(Request::Observe { id: JobId::Refresh(cell.id), application: Application::Process(1), work: Work::Refresh(cell.clone(), element()), reader: Reader { key: key.clone(), reply } }).unwrap();
        result
    }
    #[tokio::test(start_paused = true)]
    async fn shared_refresh_uses_all_tokens_and_survives_the_first_callers_disconnect() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (started, mut starts) = mpsc::unbounded_channel();
        let scheduler = tokio::spawn(run(receiver, move |work| {
            let Work::Refresh(cell, element) = work else { unreachable!() };
            let (finish, result) = oneshot::channel::<()>();
            started.send((cell.id, finish)).unwrap();
            async move { let _ = result.await; Ok(Value::Refresh(element)) }
        }));
        let first = key(); let second = key();
        let cells: Vec<_> = (0..8).map(|_| Arc::new(Refresh { id: uuid::Uuid::new_v4(), result: OnceLock::new() })).collect();
        let mut readers: Vec<_> = cells.iter().map(|cell| Some(refresh(&sender, &first, cell))).collect();
        settle().await;
        let (_, finish) = starts.try_recv().unwrap();
        let mut other = refresh(&sender, &second, &cells[7]);
        settle().await;
        finish.send(()).unwrap(); settle().await;
        let (_, finish) = starts.try_recv().unwrap();
        finish.send(()).unwrap(); settle().await;
        let (id, finish) = starts.try_recv().unwrap();
        assert_eq!(id, cells[7].id, "a shared job gets the competing token's turn");
        readers[7].take();
        prune().await;
        assert!(!finish.is_closed(), "another token still needs the shared work");
        finish.send(()).unwrap(); settle().await;
        assert!(matches!(other.try_recv().unwrap(), Ok(Value::Refresh(_))));
        assert!(cells[7].result.get().unwrap().is_ok());
        let mut cached = refresh(&sender, &second, &cells[7]);
        settle().await;
        assert!(matches!(cached.try_recv().unwrap(), Ok(Value::Refresh(_))));
        drop(readers); prune().await; drop(sender); scheduler.await.unwrap();
    }
}
