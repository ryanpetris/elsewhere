//! Runtime broadcast requests and public status. Connection settings are input-only.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Start {
    /// Retry the same request with this ID for up to ten minutes.
    pub request_id: String,
    pub label: String,
    pub url: String,
    pub stream_key: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub audio: Audio,
    pub cursor: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Audio { Desktop, Silence }

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State { Starting, Sending, Reconnecting, Stopping, Stopped, Failed }
impl State {
    pub fn terminal(self) -> bool { matches!(self, Self::Stopped | Self::Failed) }
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub state: State,
    pub frames: u64,
    pub bytes: u64,
    pub retries: u32,
    pub error: Option<String>,
}
impl Default for Progress {
    fn default() -> Self { Self { state: State::Starting, frames: 0, bytes: 0, retries: 0, error: None } }
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub audio: Audio,
    pub cursor: bool,
    #[serde(flatten)]
    pub progress: Progress,
}

#[derive(Clone, Serialize)]
pub struct Capabilities {
    pub available: bool,
    pub desktop_audio: bool,
    pub video_codec: &'static str,
    pub audio_codec: &'static str,
    pub max_outputs: usize,
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
    pub min_bitrate_kbps: u32,
    pub max_bitrate_kbps: u32,
    pub error: Option<String>,
}

pub trait Control: Send + Sync {
    fn progress(&self) -> Progress;
    fn stop(&self);
}
