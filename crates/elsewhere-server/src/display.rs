//! Shared display settings. Startup flags supply the initial values for this process.
use std::sync::Arc;

use axum::{Extension, Json, extract::State, response::{IntoResponse, Response}};
use elsewhere_core::{Bytes, Command, OutputGeometry};
use serde::{Deserialize, Serialize};

use crate::{App, Key, P, api::ApiError, protocol};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Resolution {
    #[default]
    Auto,
    Fixed { width: u32, height: u32 },
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
pub(crate) struct Settings {
    pub kiosk: bool,
    pub resolution: Resolution,
}

impl Settings {
    pub fn message(&self) -> Bytes {
        let mut message = vec![protocol::DISPLAY];
        message.extend(serde_json::to_vec(self).unwrap());
        message.into()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Update {
    kiosk: Option<bool>,
    resolution: Option<Resolution>,
}

pub(crate) async fn get(Extension(key): Extension<Key>, State(app): State<Arc<App>>) -> Response {
    if let Err(error) = key.require(P::DesktopView) { return error.into_response(); }
    (crate::NO_STORE, Json(app.viewers.lock().unwrap().display)).into_response()
}

pub(crate) async fn update(Extension(key): Extension<Key>, State(app): State<Arc<App>>, Json(update): Json<Update>) -> Response {
    match key.with(&[P::DesktopControl], || app.update_display(update)) {
        Ok(settings) => (crate::NO_STORE, Json(settings)).into_response(),
        Err(error) => error.into_response(),
    }
}

impl App {
    fn update_display(&self, update: Update) -> Result<Settings, ApiError> {
        if let Some(Resolution::Fixed { width, height }) = update.resolution {
            if [width, height].iter().any(|n| !(2..=8192).contains(n) || n % 2 != 0) {
                return Err(ApiError::InvalidSize("expected even dimensions between 2 and 8192"));
            }
        }
        let mut viewers = self.viewers.lock().unwrap();
        let settings = Settings {
            kiosk: update.kiosk.unwrap_or(viewers.display.kiosk),
            resolution: update.resolution.unwrap_or(viewers.display.resolution),
        };
        let geometry = if settings.resolution == viewers.display.resolution { None } else {
            match settings.resolution {
                Resolution::Auto => viewers.controller.and_then(|id| viewers.sessions.get(&id)).and_then(|s| s.size),
                Resolution::Fixed { width, height } => Some(OutputGeometry { width_px: width, height_px: height, scale: 1.0, ..viewers.output }),
            }
        };
        let previous_output = viewers.output;
        if let Some(geometry) = geometry { viewers.output = geometry; }
        self.retarget(&viewers);
        if let Err(error) = self.send(Command::ConfigureDisplay { kiosk: settings.kiosk, geometry }) {
            viewers.output = previous_output;
            self.retarget(&viewers);
            return Err(error);
        }
        viewers.display = settings;
        self.display_updates.send_replace(settings);
        Ok(settings)
    }
}
