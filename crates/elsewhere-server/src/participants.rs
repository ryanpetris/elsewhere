//! Desktop connection membership and controller-approved handoffs.
use std::time::{Duration, Instant};
use elsewhere_core::Bytes;
use crate::{App, Viewers, protocol, tokens::{self, Permission as P}};

pub(crate) struct ControlRequest {
    id: u64,
    epoch: u64,
    deadline: Instant,
    expires_at_ms: i64,
}

impl Viewers {
    pub(crate) fn publish_roster(&self) {
        let mut sessions: Vec<_> = self.sessions.iter().filter(|(_, s)| s.key.has(P::DesktopView)).collect();
        sessions.sort_by_key(|(id, _)| **id);
        let members: Vec<_> = sessions.into_iter().map(|(id, s)| serde_json::json!({
            "id": id.to_string(), "label": format!("Session {id}"), "can_control": s.key.has(P::DesktopControl),
            "request": s.request.as_ref().map(|r| serde_json::json!({ "id": r.id.to_string(), "epoch": r.epoch.to_string(), "expires_at_ms": r.expires_at_ms })),
            "result": s.request_result,
        })).collect();
        let mut message = vec![protocol::ROSTER];
        serde_json::to_writer(&mut message, &serde_json::json!({ "controller": self.controller.map(|id| id.to_string()), "epoch": self.control_epoch.to_string(), "sessions": members })).unwrap();
        self.roster.send_replace(Bytes::from(message));
    }

    pub(crate) fn expire_requests(&mut self) {
        let now = Instant::now();
        let mut changed = false;
        for s in self.sessions.values_mut() {
            if s.request.as_ref().is_some_and(|r| now >= r.deadline) {
                s.request = None;
                s.request_result = Some("expired");
                changed = true;
            }
        }
        if changed { self.publish_roster(); }
    }

    pub(crate) fn end_requests(&mut self) {
        for s in self.sessions.values_mut() {
            if s.request.take().is_some() { s.request_result = Some("controller_changed"); }
        }
    }
}

impl App {
    /// Called with the admitted caller and the viewers lock held.
    pub(crate) fn request_control(&self, v: &mut Viewers, id: u64) {
        v.expire_requests();
        let Some(s) = v.sessions.get_mut(&id) else { return; };
        if !s.key.has(P::DesktopControl) {
            let _ = s.events.try_send(protocol::notice("This token does not allow desktop control."));
            return;
        }
        if v.controller == Some(id) { return; }
        if v.controller.is_none() { self.set_controller(v, Some(id)); return; }
        if s.request.is_some() { return; }
        s.request = Some(ControlRequest { id: v.next_request, epoch: v.control_epoch, deadline: Instant::now() + Duration::from_secs(30), expires_at_ms: tokens::now_ms() + 30_000 });
        v.next_request += 1;
        s.request_result = None;
        v.publish_roster();
    }

    pub(crate) fn cancel_control(&self, v: &mut Viewers, id: u64, request: u64, epoch: u64) {
        v.expire_requests();
        if let Some(s) = v.sessions.get_mut(&id) {
            if s.request.as_ref().is_some_and(|r| r.id == request && r.epoch == epoch) {
                s.request = None;
                s.request_result = Some("cancelled");
                v.publish_roster();
            }
        }
    }

    pub(crate) fn decide_control(&self, v: &mut Viewers, id: u64, target: u64, request: u64, epoch: u64, approve: bool) {
        v.expire_requests();
        let valid = v.controller == Some(id) && v.control_epoch == epoch
            && v.sessions.get(&id).is_some_and(|s| s.key.has(P::DesktopControl))
            && v.sessions.get(&target).is_some_and(|s| s.key.has(P::DesktopControl)
                && s.request.as_ref().is_some_and(|r| r.id == request && r.epoch == epoch));
        if !valid {
            if let Some(s) = v.sessions.get(&id) { let _ = s.events.try_send(protocol::notice("This control request is no longer pending.")); }
            return;
        }
        if approve {
            let s = v.sessions.get_mut(&target).unwrap();
            s.request = None;
            s.request_result = Some("approved");
            self.set_controller(v, Some(target));
        }
        else {
            let s = v.sessions.get_mut(&target).unwrap();
            s.request = None;
            s.request_result = Some("declined");
            v.publish_roster();
        }
    }
}
