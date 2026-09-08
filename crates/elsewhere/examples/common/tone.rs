//! FFmpeg test tones played through a native PipeWire or Pulse client.
use anyhow::Result;
use std::process::{Child, Command, Stdio};

pub struct Tone { generator: Child, player: Child }

impl Tone {
    pub fn start(env: &[(String, String)], frequency: u32, volume: f32, channels: u32,
        name: &str, application: &str, target: Option<&str>, pulse: bool) -> Result<Self>
    {
        let mut generator = Command::new("ffmpeg").args(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            &format!("sine=frequency={frequency}:sample_rate=48000"), "-af", &format!("volume={}{}", volume * 8.0,
                if channels == 2 { ",pan=stereo|c0=c0|c1=c0" } else { "" }),
            "-ac", &channels.to_string(), "-f", "f32le", "pipe:1"])
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let mut command = if pulse {
            let mut command = Command::new("pacat");
            command.args(["--playback", "--raw", "--format=float32le", "--rate=48000", &format!("--channels={channels}"),
                "--latency-msec=20", &format!("--stream-name={name}"), &format!("--client-name={application}")]);
            if let Some(target) = target { command.arg(format!("--device={target}")); }
            command
        } else {
            let mut command = Command::new("pw-cat");
            command.args(["--playback", "--raw", "--format=f32", "--rate=48000", &format!("--channels={channels}"), "--latency=20ms",
                "--properties", &format!("{{ node.name = {name} node.description = {name} media.name = {name} application.name = {application} }}")]);
            if let Some(target) = target { command.args(["--target", target]); }
            command.arg("-");
            command
        };
        let result = command.envs(env.iter().cloned()).stdin(generator.stdout.take().unwrap()).stdout(Stdio::null()).spawn();
        match result {
            Ok(player) => Ok(Self { generator, player }),
            Err(error) => { let _ = generator.kill(); let _ = generator.wait(); Err(error.into()) }
        }
    }
}

impl Drop for Tone {
    fn drop(&mut self) {
        let _ = self.player.kill(); let _ = self.player.wait();
        let _ = self.generator.kill(); let _ = self.generator.wait();
    }
}
