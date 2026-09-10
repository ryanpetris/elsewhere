//! Controlled compositor retry check. Run checks/render-retry.sh in Docker.
use std::{process::{Child, Command as Process}, sync::{Arc, atomic::{AtomicU32, AtomicUsize, Ordering::SeqCst}}, time::{Duration, Instant}};
use elsewhere_core::{Command, Event, Frame, FrameBuffer, FrameSink, OutputGeometry, SinkError, Submit};

#[derive(Default)]
struct Probe { mode: AtomicUsize, calls: AtomicUsize, accepted: AtomicUsize, refined: AtomicUsize, color: AtomicU32 }
struct Sink { probe: Arc<Probe>, due: Instant, cadence: bool }
impl FrameSink for Sink {
    fn output_changed(&mut self, _: OutputGeometry, _: u32, _: u64) {}
    fn wants_pixels(&self) -> bool { true }
    fn cadence(&self) -> Option<Duration> { self.cadence.then_some(Duration::from_millis(40)) }
    fn submit(&mut self, frame: Frame) -> Result<Submit, SinkError> {
        self.probe.calls.fetch_add(1, SeqCst);
        if frame.refine { self.probe.refined.fetch_add(1, SeqCst); }
        let result = match self.probe.mode.load(SeqCst) {
            1 => Submit::Held,
            2 => Submit::Deferred,
            3 => Submit::RetryAt(self.due),
            _ => Submit::Encoded,
        };
        if result == Submit::Encoded {
            self.probe.accepted.fetch_add(1, SeqCst);
            if let FrameBuffer::Memory { data, stride } = frame.buffer {
                let offset = (frame.height / 2 * stride + frame.width / 2 * 4) as usize;
                let pixel = &data[offset..offset + 4];
                let bgra = frame.fourcc == u32::from_le_bytes(*b"XR24") || frame.fourcc == u32::from_le_bytes(*b"AR24");
                let (r, b) = if bgra { (pixel[2], pixel[0]) } else { (pixel[0], pixel[2]) };
                self.probe.color.store((r as u32) << 16 | (pixel[1] as u32) << 8 | b as u32, SeqCst);
            }
        }
        Ok(result)
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !condition() { assert!(Instant::now() < until, "retry check timed out"); std::thread::sleep(Duration::from_millis(10)); }
}
struct Rig { compositor: Option<elsewhere_compositor::CompositorHandle>, source: Child }
impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.source.kill(); let _ = self.source.wait();
        let compositor = self.compositor.take().unwrap();
        let _ = compositor.commands.send(Command::Quit);
        let _ = compositor.join.join();
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let render_node = std::env::var_os("ELSEWHERE_RENDER_NODE").map(Into::into);
    let software = render_node.is_none();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let compositor = elsewhere_compositor::spawn(elsewhere_compositor::Config {
        render_node, socket_name: "wayland-render-retry".into(),
        initial: OutputGeometry { width_px: 320, height_px: 240, scale: 1.0, refresh_mhz: 30_000 },
        exec: None, exec_env: vec![], kiosk: true, frame_transport: if software { elsewhere_core::FrameTransport::Memory } else { elsewhere_core::FrameTransport::Dmabuf },
        validate_format: Box::new(|_| Ok(())),
    }, events).unwrap();
    let source = Process::new(&args[1]).arg(&args[2]).env("WAYLAND_DISPLAY", &compositor.socket_name).spawn().unwrap();
    let rig = Rig { compositor: Some(compositor), source };
    let commands = &rig.compositor.as_ref().unwrap().commands;
    let mut window = None;
    wait(|| {
        while let Ok(event) = received.try_recv() {
            if let Event::Windows(windows) = event { window = windows.iter().find(|w| w.app_id == "thumbnail-surfaces").map(|w| w.id); }
        }
        window.is_some()
    });
    for mode in [1, 2, 3] {
        let probes: Vec<_> = (0..5).map(|_| Arc::new(Probe::default())).collect();
        probes[1].mode.store(mode, SeqCst); probes[3].mode.store(mode, SeqCst);
        let due = Instant::now() + Duration::from_secs(2);
        for (key, probe) in probes.iter().enumerate() {
            let sink = Some(Box::new(Sink { probe: probe.clone(), due, cadence: key == 4 }) as Box<dyn FrameSink>);
            commands.send(if key < 2 || key == 4 { Command::ViewerStream { key: key as u64, sink } }
                else { Command::WindowStream { key: key as u64, window: window.unwrap(), sink } }).unwrap();
        }
        std::thread::sleep(Duration::from_millis(350));
        let before: Vec<_> = probes.iter().map(|p| p.calls.load(SeqCst)).collect();
        std::thread::sleep(Duration::from_millis(200));
        let extra: Vec<_> = probes.iter().zip(&before).map(|(p, n)| p.calls.load(SeqCst) - n).collect();
        assert_eq!(extra[0], 0, "healthy desktop retried");
        assert_eq!(extra[2], 0, "healthy window retried");
        if mode == 1 { assert!(extra[1] > 0 && extra[3] > 0, "transient retries stopped"); }
        else { assert_eq!((extra[1], extra[3]), (0, 0), "deferred or timed sinks polled"); }
        assert!(extra[4] >= 2, "broadcast cadence stopped");
        println!("mode {mode}: static desktop/window/cadence submissions {extra:?}");
        let color = if mode == 2 { 0x0000ff } else { 0x00ff00 };
        std::fs::write(&args[2], format!("root ff{color:06x}")).unwrap();
        wait(|| probes[0].color.load(SeqCst) == color && (!software || probes[2].color.load(SeqCst) == color));
        // Keep the sinks blocked through the changed picture's desktop refinement.
        std::thread::sleep(Duration::from_millis(250));
        if mode == 3 { assert!(Instant::now() < due, "deadline elapsed before the recovery check"); }
        probes[1].mode.store(0, SeqCst); probes[3].mode.store(0, SeqCst);
        if mode == 2 { commands.send(Command::RequestFullFrame).unwrap(); }
        wait(|| probes[1].color.load(SeqCst) == color && probes[3].accepted.load(SeqCst) > 0
            && (!software || probes[3].color.load(SeqCst) == color));
        if mode == 3 { assert!(Instant::now() >= due, "timed sink recovered before its deadline"); }
        std::thread::sleep(Duration::from_millis(250));
        let before: Vec<_> = probes[..4].iter().map(|p| p.calls.load(SeqCst)).collect();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(before, probes[..4].iter().map(|p| p.calls.load(SeqCst)).collect::<Vec<_>>(), "recovered streams did not settle");
        assert!(probes[0].refined.load(SeqCst) > 0, "desktop refinement missing");
        for key in 0..5 {
            commands.send(if key < 2 || key == 4 { Command::ViewerStream { key, sink: None } }
                else { Command::WindowStream { key, window: window.unwrap(), sink: None } }).unwrap();
        }
        println!("mode {mode}: final picture delivered and streams settled");
    }
}
