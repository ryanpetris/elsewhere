//! A commands.execute terminal with a real PTY and the compositor's client environment.
use std::{
    ffi::CStr, fs::{File, OpenOptions}, io::{self, Read, Write},
    os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::OpenOptionsExt, process::CommandExt}},
    process::Stdio, sync::Arc, time::Duration,
};
use anyhow::{Result, bail};
use axum::{extract::{State, ws::{Message, WebSocket, WebSocketUpgrade}}, response::Response};
use serde::Deserialize;
use tokio::{io::unix::AsyncFd, time::timeout};
use crate::{App, Command, Key, tokens::Permission as P};

const WINDOW: usize = 256 * 1024;

pub async fn upgrade(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(64 * 1024).on_upgrade(move |mut socket| async move {
        let Some(key) = crate::ws::authenticate(&mut socket, &app).await else {
            let _ = socket.send(Message::Close(None)).await;
            return;
        };
        if !key.has(P::CommandsExecute) { let _ = socket.send(Message::Close(None)).await; return; }
        if let Err(error) = session(&mut socket, &app, &key).await {
            tracing::warn!(%error, "terminal ended");
            let _ = timeout(Duration::from_secs(1), socket.send(Message::Text("Terminal unavailable or connection closed.".into()))).await;
        }
        let _ = timeout(Duration::from_secs(1), socket.send(Message::Close(None))).await;
    })
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Control {
    Resize { cols: u16, rows: u16 },
    Ack { ack: usize },
}

fn pty() -> Result<(File, File)> {
    // Open both descriptors close-on-exec atomically: other sessions can spawn concurrently.
    let fd = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if fd < 0 { return Err(io::Error::last_os_error().into()); }
    let master = unsafe { File::from_raw_fd(fd) };
    if unsafe { libc::grantpt(fd) } < 0 || unsafe { libc::unlockpt(fd) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let mut name = [0; 256];
    let error = unsafe { libc::ptsname_r(fd, name.as_mut_ptr(), name.len()) };
    if error != 0 { return Err(io::Error::from_raw_os_error(error).into()); }
    let name = unsafe { CStr::from_ptr(name.as_ptr()) };
    let slave = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOCTTY | libc::O_CLOEXEC)
        .open(std::ffi::OsStr::from_bytes(name.to_bytes()))?;
    resize(&master, 80, 24)?;
    Ok((master, slave))
}

fn resize(master: &File, cols: u16, rows: u16) -> Result<()> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) { bail!("invalid terminal size"); }
    let size = libc::winsize { ws_col: cols, ws_row: rows, ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

async fn session(socket: &mut WebSocket, app: &App, key: &Key) -> Result<()> {
    let (reply, receive) = std::sync::mpsc::channel();
    app.commands.send(Command::ShellCommand { reply }).map_err(|_| anyhow::anyhow!("desktop unavailable"))?;
    let mut command = tokio::task::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(3))).await??;
    if !key.has(P::CommandsExecute) { bail!("token revoked"); }
    let (master, slave) = pty()?;
    command.env("TERM", "xterm-256color").env("COLORTERM", "truecolor")
        .stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let master = AsyncFd::new(master)?;
    let mut command = tokio::process::Command::from(command);
    let mut child = key.with(&[P::CommandsExecute], || command.kill_on_drop(true).spawn().map_err(|_| crate::api::ApiError::Internal("interactive shell failed".into())))?;
    // The command owns its Stdio files after spawn; release them so slave EOF can reach the master.
    drop(command);
    let result = tokio::select! { biased; _ = key.ended() => Err(anyhow::anyhow!("token revoked or expired")), result = transfer(socket, key, &master, &mut child) => result };
    // Closing the master hangs up the foreground job as a local terminal would. Reap the shell.
    drop(master);
    if timeout(Duration::from_secs(1), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    result
}

async fn transfer(socket: &mut WebSocket, key: &Key, master: &AsyncFd<File>, child: &mut tokio::process::Child) -> Result<()> {
    let mut buffer = [0; 16 * 1024];
    let mut input = Vec::new();
    let mut in_flight = 0;
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            biased;
            _ = key.ended() => bail!("token revoked or expired"),
            ready = master.writable(), if !input.is_empty() => {
                match ready?.try_io(|fd| fd.get_ref().write(&input)) {
                    Ok(Ok(0)) => bail!("terminal stopped accepting input"),
                    Ok(Ok(count)) => { input.drain(..count); }
                    Ok(Err(error)) => return Err(error.into()),
                    Err(_) => {}
                }
            }
            ready = master.readable(), if in_flight < WINDOW => {
                let size = buffer.len().min(WINDOW - in_flight);
                match ready?.try_io(|fd| fd.get_ref().read(&mut buffer[..size])) {
                    Ok(Ok(0)) => return Ok(()),
                    Ok(Ok(count)) => {
                        timeout(Duration::from_secs(5), socket.send(Message::Binary(buffer[..count].to_vec().into()))).await??;
                        in_flight += count;
                    }
                    Ok(Err(error)) if error.raw_os_error() == Some(libc::EIO) => return Ok(()),
                    Ok(Err(error)) => return Err(error.into()),
                    Err(_) => {}
                }
            }
            incoming = socket.recv() => {
                if !key.has(P::CommandsExecute) { bail!("token revoked"); }
                match incoming {
                    Some(Ok(Message::Binary(data))) => {
                        if input.len() + data.len() > WINDOW { bail!("terminal input exceeded buffer"); }
                        input.extend_from_slice(&data);
                    }
                    Some(Ok(Message::Text(text))) => match serde_json::from_str(&text)? {
                        Control::Resize { cols, rows } => resize(master.get_ref(), cols, rows)?,
                        Control::Ack { ack } => {
                            if ack > in_flight { bail!("invalid terminal acknowledgement"); }
                            in_flight -= ack;
                        }
                    },
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(error)) => return Err(error.into()),
                    _ => {}
                }
            }
            _ = tick.tick() => {
                if !key.has(P::CommandsExecute) { bail!("token revoked"); }
                if in_flight == 0 && child.try_wait()?.is_some() { return Ok(()); }
            }
        }
    }
}
