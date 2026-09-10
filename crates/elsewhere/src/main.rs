use std::{net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result};
use elsewhere_core::{Codec, FrameSink, StreamControl};
use clap::Parser;
use tokio::sync::mpsc;

mod audio;
mod gtk;

#[derive(Parser)]
#[command(about = "A Wayland compositor whose screen is a browser tab", version = env!("ELSEWHERE_VERSION"))]
struct Cli {
    #[command(subcommand)]
    command: Option<Operation>,
    #[arg(long, hide = true)]
    audio_worker: bool,
    #[arg(long, hide = true)]
    broadcast_output_worker: bool,
    /// Address to serve the viewer on.
    #[arg(long, default_value = "0.0.0.0:8443")]
    listen: SocketAddr,
    /// Plain HTTP for localhost or a reverse proxy that terminates HTTPS.
    #[arg(long)]
    no_tls: bool,
    /// Public URL path, such as /elsewhere/alice. Nested paths are supported.
    #[arg(long, default_value = "", value_parser = parse_url_prefix)]
    url_prefix: String,
    /// The proxy removes --url-prefix before forwarding requests to this server.
    #[arg(long, requires = "url_prefix")]
    proxy_strips_prefix: bool,
    /// Medium quality bitrate ceiling in kbit/s; other quality levels have their own ceilings.
    #[arg(long, default_value_t = 8000)]
    bitrate: u32,
    /// Comma-separated codecs to allow. Only these encoders are probed; the browser ranks them.
    #[arg(long, value_delimiter = ',', default_value = "h264,hevc,av1,vp9,vp8", value_parser = ["h264", "hevc", "vp9", "av1", "vp8"])]
    codecs: Vec<String>,
    /// Encode on the CPU (libvpx, x264, x265, libaom: whichever is installed) instead of with VA-API or NVENC,
    /// for machines without a usable GPU encoder. Slower; the desktop runs at 30 Hz.
    #[arg(long)]
    software_encoding: bool,
    /// Command to run (via `sh -c`) at startup, with WAYLAND_DISPLAY, DISPLAY, PIPEWIRE_REMOTE, PULSE_SERVER
    /// and a Wayland session's environment set for it.
    #[arg(long)]
    exec: Option<String>,
    /// Keep the desktop at WIDTHxHEIGHT pixels and scale it to fit each browser.
    /// Both dimensions must be even and between 2 and 8192.
    #[arg(long, value_name = "WIDTHxHEIGHT", value_parser = parse_screen_size)]
    screen_size: Option<(u32, u32)>,
    /// Fullscreen every window: for running a nested desktop such as
    /// `--exec 'dbus-run-session -- gnome-shell --devkit'`.
    #[arg(long)]
    kiosk: bool,
    /// The GPU's render node. `none`, or the default node not being there, renders with Mesa's llvmpipe
    /// (no GPU at all: a VPS, a container without devices) and encodes in software.
    #[arg(long, default_value = DEFAULT_RENDER_NODE)]
    render_node: PathBuf,
    #[arg(long, default_value = "elsewhere")]
    socket_name: String,
    /// No audio either way: neither the clients' for the browser nor the browser's microphone for them.
    #[arg(long)]
    no_audio: bool,
    /// No WebRTC: the video stays on the WebSocket (TCP) for every viewer.
    #[arg(long)]
    no_rtc: bool,
    /// Local and advertised UDP port for WebRTC. Defaults to the listen port.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    rtc_port: Option<u16>,
    /// Use this WebRTC IP instead of the page's hostname.
    /// Use when UDP is reached at a different endpoint from HTTPS; forward the UDP port to this server.
    #[arg(long)]
    rtc_addr: Option<std::net::IpAddr>,
    /// A STUN server for the browsers (`stun:host:3478`); none means host candidates only, enough on a LAN.
    #[arg(long)]
    stun: Vec<String>,
    /// A TURN server for browsers behind a strict NAT (`turn:host:3478`), with its credentials.
    #[arg(long)]
    turn: Option<String>,
    #[arg(long, requires = "turn")]
    turn_user: Option<String>,
    #[arg(long, requires = "turn")]
    turn_pass: Option<String>,
    /// A v4l2loopback device (`modprobe v4l2loopback exclusive_caps=1 card_label=elsewhere`, then its
    /// /dev/videoN) that the browser's webcam is played into, for applications to use as a camera.
    #[arg(long)]
    webcam: Option<PathBuf>,
    /// Serve each window's UI elements (roles, names, rectangles) on /api/windows/{id}/elements, read from
    /// the toolkits' accessibility trees over the D-Bus session this process was started in.
    #[arg(long)]
    elements: bool,
    /// Where files dropped on the page land and the page's downloads come from (default: the XDG
    /// download directory, `~/Downloads`).
    #[arg(long)]
    files_dir: Option<PathBuf>,
}

#[derive(clap::Subcommand)]
enum Operation {
    /// Manage tokens in the configured state database.
    Token {
        #[command(subcommand)]
        command: TokenOperation,
    },
}

#[derive(clap::Subcommand)]
enum TokenOperation {
    /// Create a token and print its secret once.
    Create {
        /// Grant every implemented permission, with no expiry.
        #[arg(long, required = true)]
        admin: bool,
    },
}

const DEFAULT_RENDER_NODE: &str = "/dev/dri/renderD128";

fn parse_screen_size(value: &str) -> std::result::Result<(u32, u32), String> {
    let invalid = || "expected WIDTHxHEIGHT with even dimensions between 2 and 8192".to_string();
    let (w, h) = value.split_once('x').ok_or_else(invalid)?;
    let dimension = |s: &str| s.parse::<u32>().ok().filter(|n| (2..=8192).contains(n) && n % 2 == 0).ok_or_else(invalid);
    Ok((dimension(w)?, dimension(h)?))
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.broadcast_output_worker { return elsewhere_stream::broadcast::output_worker(); }
    if let Some(Operation::Token { command: TokenOperation::Create { admin: _ } }) = cli.command {
        use std::io::Write;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let created = runtime.block_on(async {
            let store = elsewhere_server::tokens::Store::open(elsewhere_server::Config::default_data_dir()?.join("state.sqlite3")).await?;
            store.create(elsewhere_server::tokens::Create::admin()).await
        })?;
        let mut output = std::io::stdout().lock();
        writeln!(output, "{}", created.token)?;
        output.flush()?;
        return Ok(());
    }
    if cli.audio_worker {
        tracing_subscriber::fmt().with_writer(std::io::stderr).init();
        return audio::worker();
    }
    // Reuse freed codec allocations across viewer workers instead of retaining an arena per worker.
    // Explicit glibc settings take precedence. This runs before application worker threads start.
    #[cfg(target_env = "gnu")]
    {
        let configured = std::env::var_os("MALLOC_ARENA_MAX").is_some_and(|value| !value.is_empty())
            || std::env::var_os("GLIBC_TUNABLES").is_some_and(|value| {
                value.as_encoded_bytes().split(|byte| *byte == b':')
                    .any(|setting| setting.strip_prefix(b"glibc.malloc.arena_max=").is_some_and(|value| !value.is_empty()))
            });
        if !configured && unsafe { libc::mallopt(libc::M_ARENA_MAX, 2) } == 0 {
            eprintln!("warning: allocation arena limit unavailable");
        }
    }
    let stopping = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGINT, stopping.clone())?;
    signal_hook::flag::register(signal_hook::consts::SIGTERM, stopping.clone())?;
    // Headless machines (no session) may lack XDG_RUNTIME_DIR; give the Wayland socket a private home.
    if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = format!("/tmp/elsewhere-{}", std::fs::metadata("/proc/self")?.uid());
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        // Safety: single-threaded at this point.
        unsafe { std::env::set_var("XDG_RUNTIME_DIR", &dir) };
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();
    let allowed: Vec<_> = cli.codecs.iter().map(|name| match name.as_str() {
        "h264" => Codec::H264, "hevc" => Codec::Hevc, "vp9" => Codec::Vp9,
        "av1" => Codec::Av1, "vp8" => Codec::Vp8, _ => unreachable!(),
    }).collect();
    // a node given by hand must be there; only the default one may be missing (a machine without a GPU)
    let render_node = match cli.render_node.as_os_str().to_str() {
        Some("none") => None,
        _ if cli.render_node.exists() => Some(cli.render_node.clone()),
        Some(DEFAULT_RENDER_NODE) => None,
        _ => anyhow::bail!("render node {} isn't there (--render-node none renders without a GPU)", cli.render_node.display()),
    };
    if render_node.is_none() {
        tracing::info!("no GPU ({}): rendering in software, encoding in software", cli.render_node.display());
    }
    let software = cli.software_encoding || render_node.is_none();
    let encoders = elsewhere_stream::Encoders::probe(render_node.as_deref(), software, &allowed)?;
    let codecs = encoders.codecs();
    tracing::info!(?codecs, software, "video encoders");
    let (audio_tx, audio_rx) = mpsc::channel(16);
    let (events_tx, events_rx) = mpsc::unbounded_channel();

    let mut audio = if cli.no_audio { None } else {
        match audio::Session::start(&stopping, audio_tx) {
            Ok(session) => {
                tracing::info!(environment = ?session.client_env(), "private session audio ready");
                Some(session)
            }
            Err(e) => { tracing::warn!("audio unavailable: {e:#}"); None }
        }
    };
    if stopping.load(std::sync::atomic::Ordering::Relaxed) { return Ok(()); }

    let mut cam = None; // the browser's webcam: its playback worker and the frames' way in
    if let Some(device) = &cli.webcam {
        let (cam_tx, cam_rx) = mpsc::channel(16);
        match elsewhere_stream::video_sink(device, cam_rx) {
            Ok(stream) => {
                tracing::info!("webcam: the browser's camera plays into {}", device.display());
                cam = Some((stream, cam_tx));
            }
            Err(e) => tracing::warn!("webcam disabled: {e:#}"),
        }
    }

    let broadcast_socket = audio.as_ref().and_then(|s| s.client_env().into_iter().find(|(k, _)| k == "PIPEWIRE_REMOTE").map(|(_, v)| std::path::PathBuf::from(v)));
    let capabilities_socket = broadcast_socket.clone();
    let broadcast = elsewhere_server::broadcast::Backend {
        start: Box::new(move |settings| elsewhere_stream::broadcast::start(settings, broadcast_socket.clone())),
        capabilities: Box::new(move || elsewhere_stream::broadcast::capabilities(capabilities_socket.as_ref().is_some_and(|p| p.exists()))),
    };
    let mut exec_env = audio.as_ref().map(audio::Session::client_env).unwrap_or_else(|| {
        // An unavailable session must not send its applications to the host audio server.
        vec![("PIPEWIRE_REMOTE".into(), "/dev/null".into()), ("PULSE_SERVER".into(), "unix:/dev/null".into()), ("PIPEWIRE_CONFIG_DIR".into(), "/dev/null".into())]
    });
    // Hold for the session: dropping this directory removes the client schema defaults.
    let gtk_defaults = gtk::defaults()?;
    let data_dirs = std::env::var("XDG_DATA_DIRS").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    exec_env.push(("XDG_DATA_DIRS".into(), format!("{}:{data_dirs}", gtk_defaults.path().display())));
    exec_env.push(("ELSEWHERE_WEBCAM_DEVICE".into(), cli.webcam.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()));
    if cli.elements {
        // GTK always publishes its tree; Firefox and Qt only when asked. (Chromium needs --force-renderer-accessibility.)
        exec_env.extend([("GNOME_ACCESSIBILITY", "1"), ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1")].map(|(k, v)| (k.to_string(), v.to_string())));
    }
    let frame_transport = encoders.frame_transport();
    let probe_encoders = encoders.clone();
    let validate_format = Box::new(move |frame| probe_encoders.validate_frame(frame));
    let data_dir = elsewhere_server::Config::default_data_dir()?;
    let files_dir = std::path::absolute(cli.files_dir.unwrap_or_else(elsewhere_server::files::default_dir))?;
    let mut initial = elsewhere_core::OutputGeometry {
        // The CPU encoders get every frame at half the rate instead of every other frame.
        refresh_mhz: if software { 30_000 } else { 60_000 },
        ..elsewhere_core::INITIAL_OUTPUT
    };
    if let Some((width, height)) = cli.screen_size {
        initial.width_px = width;
        initial.height_px = height;
    }
    let runtime = tokio::runtime::Runtime::new()?;
    let elsewhere_compositor::CompositorHandle { commands, socket_name, x11_display, join } = elsewhere_compositor::spawn(
        elsewhere_compositor::Config {
            render_node,
            socket_name: cli.socket_name,
            initial,
            exec: cli.exec.clone(),
            exec_env,
            kiosk: cli.kiosk,
            frame_transport,
            validate_format,
        },
        events_tx,
    )?;
    tracing::info!(socket = %socket_name, x11_display = ?x11_display.map(|d| format!(":{d}")), "compositor ready");
    let bitrate = cli.bitrate;
    let redraw_commands = commands.clone();
    let redraw: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
        let _ = redraw_commands.send(elsewhere_core::Command::RequestFullFrame);
    });
    let sinks: elsewhere_server::SinkFactory = Box::new(move |tx| {
        let sink = elsewhere_stream::FfmpegSink::new(bitrate, encoders.clone(), tx, redraw.clone())?;
        let control = sink.control();
        Ok((Box::new(sink) as Box<dyn FrameSink>, Box::new(control) as Box<dyn StreamControl>))
    });
    // the compositor ends on Quit (the API, the viewer's power menu) or when it panics
    let (exited_tx, mut exited_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = exited_tx.send(join.join().is_ok());
    });

    let rtc = (!cli.no_rtc).then(|| {
        let mut ice_servers: Vec<serde_json::Value> = cli.stun.iter().map(|s| serde_json::json!({ "urls": s })).collect();
        if let Some(turn) = &cli.turn {
            ice_servers.push(serde_json::json!({ "urls": turn, "username": cli.turn_user, "credential": cli.turn_pass }));
        }
        elsewhere_server::rtc::Config { port: cli.rtc_port.unwrap_or(cli.listen.port()), addr: cli.rtc_addr, ice_servers }
    });
    let server = elsewhere_server::Config { listen: cli.listen, tls: !cli.no_tls, url_prefix: cli.url_prefix, proxy_strips_prefix: cli.proxy_strips_prefix, codecs, software, bitrate_kbps: cli.bitrate, initial, fixed_size: cli.screen_size.is_some(), kiosk: cli.kiosk, data_dir, elements: cli.elements, files_dir, version: env!("ELSEWHERE_VERSION"), sinks, broadcast, audio_available: audio.is_some(), mixer: audio.as_mut().and_then(|session| session.mixer.take()), mic: audio.as_ref().map(|session| session.mic.clone()), cam: cam.as_ref().map(|(_, tx)| tx.clone()), rtc };
    // Ctrl+C and SIGTERM (`docker stop`, a service manager) return here so the audio devices get unloaded
    // and the media workers stopped.
    let result = runtime.block_on(async {
        let mut health = tokio::time::interval(std::time::Duration::from_millis(100));
        let server = elsewhere_server::run(server, commands.clone(), audio_rx, events_rx);
        tokio::pin!(server);
        let mut compositor_exited = false;
        let result = loop {
        tokio::select! {
            _ = health.tick() => {
                if stopping.load(std::sync::atomic::Ordering::Relaxed) { break Ok(()); }
                if let Some(session) = &mut audio {
                    if let Err(e) = session.check() {
                        tracing::warn!("audio unavailable: {e:#}");
                        audio.take();
                    }
                }
            }
            r = &mut server => break r,
            ok = &mut exited_rx => {
                compositor_exited = true;
                break if ok.unwrap_or(false) { Ok(()) } else { Err(anyhow::anyhow!("the compositor thread died")) };
            },
        }
        };
        if !compositor_exited {
            let _ = commands.send(elsewhere_core::Command::Quit);
            let _ = exited_rx.await;
        }
        result
    });
    drop(audio);
    drop(cam);
    result
}

/// Keep prefixes literal in HTML, URLs and Axum routes; reject escapes and route parameters.
fn parse_url_prefix(value: &str) -> Result<String, String> {
    if value.is_empty() || value == "/" { return Ok(String::new()); }
    let prefix = value.trim_end_matches('/');
    if !prefix.starts_with('/') || prefix[1..].split('/').any(|part| {
        part.is_empty() || part == "." || part == ".."
            || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    }) {
        return Err("URL prefix must be an absolute path of nonempty segments using letters, digits, -, ., _, or ~; . and .. segments are not allowed".into());
    }
    Ok(prefix.into())
}

#[cfg(test)]
mod url_prefix_tests {
    use super::*;

    #[test]
    fn prefixes_are_literal_nested_paths() {
        for (input, expected) in [("", ""), ("/", ""), ("/alice/", "/alice"), ("/elsewhere/alice/", "/elsewhere/alice"), ("/a-b/c_d.v~1", "/a-b/c_d.v~1")] {
            assert_eq!(parse_url_prefix(input).unwrap(), expected);
        }
        for input in ["alice", "//", "//alice", "/a//b", "/a/../b", "/./b", "/%2e", "/a?b", "/a#b", "/a\\b", "/<script>", "/{id}", "/a:b", "/a b"] {
            assert!(parse_url_prefix(input).is_err(), "{input}");
        }
        assert!(Cli::try_parse_from(["elsewhere", "--proxy-strips-prefix"]).is_err());
        assert!(Cli::try_parse_from(["elsewhere", "--url-prefix", "/elsewhere/alice", "--proxy-strips-prefix"]).is_ok());
    }
}
