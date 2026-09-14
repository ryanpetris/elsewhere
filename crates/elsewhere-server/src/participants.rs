//! Desktop participants, their connections, and controller-approved handoffs.
use std::time::{Duration, Instant};
use elsewhere_core::Bytes;
use crate::{App, Key, Viewers, protocol, tokens::{self, Permission as P}};

pub(crate) struct Participant {
    pub(crate) token: uuid::Uuid,
    pub(crate) secret: String,
    pub(crate) active: u64,
    pub(crate) request: Option<ControlRequest>,
    pub(crate) request_result: Option<&'static str>,
}

impl Participant {
    pub(crate) fn new(id: u64, key: &Key) -> Self {
        Self { token: key.metadata.id, secret: crate::random_hex(32), active: id, request: None, request_result: None }
    }
}

pub(crate) struct ControlRequest {
    id: u64,
    epoch: u64,
    deadline: Instant,
    expires_at_ms: i64,
}

#[cfg(test)]
impl ControlRequest {
    pub(crate) fn elapse(&mut self) { self.deadline = Instant::now(); }
}

impl Viewers {
    pub(crate) fn participant_of(&self, session: u64) -> Option<u64> { self.sessions.get(&session).map(|s| s.participant) }
    pub(crate) fn can_control(&self, participant: u64) -> bool {
        self.sessions.values().any(|s| s.participant == participant && s.key.has(P::DesktopControl))
    }
    pub(crate) fn owns_control(&self, session: u64) -> bool {
        self.sessions.get(&session).is_some_and(|s| Some(s.participant) == self.controller && s.key.has(P::DesktopControl))
    }
    pub(crate) fn active_session(&self) -> Option<u64> {
        self.controller.and_then(|id| self.participants.get(&id)).map(|p| p.active)
    }
    pub(crate) fn drives(&self, session: u64) -> bool { self.active_session() == Some(session) && self.owns_control(session) }
    pub(crate) fn media_session(&self) -> Option<u64> {
        self.sessions.iter().filter(|(_, s)| Some(s.participant) == self.controller && s.key.has(P::DesktopControl))
            .min_by_key(|(id, s)| (s.pip, **id)).map(|(id, _)| *id)
    }

    pub(crate) fn register_participant(&mut self, id: u64, key: &Key, join: Option<&protocol::JoinParticipant>) -> Result<u64, &'static str> {
        if let Some(join) = join {
            if join.secret.len() != 64 || !join.secret.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("Invalid participant association."); }
            if let Some((&participant, record)) = self.participants.iter().find(|(_, p)| p.secret == join.secret) {
                if record.token != key.metadata.id { return Err("Participant association requires the opener's token."); }
                return Ok(participant);
            }
            if !join.resume { return Err("The opener's participant is no longer connected."); }
        }
        self.participants.insert(id, Participant::new(id, key));
        Ok(id)
    }

    pub(crate) fn publish_roster(&self) {
        let mut participants: Vec<_> = self.participants.iter().collect();
        participants.sort_by_key(|(id, _)| **id);
        let members: Vec<_> = participants.into_iter().map(|(id, p)| serde_json::json!({
            "id": id.to_string(), "label": format!("Session {id}"), "can_control": self.can_control(*id),
            "request": p.request.as_ref().map(|r| serde_json::json!({ "id": r.id.to_string(), "epoch": r.epoch.to_string(), "expires_at_ms": r.expires_at_ms })),
            "result": p.request_result,
        })).collect();
        let mut message = vec![protocol::ROSTER];
        serde_json::to_writer(&mut message, &serde_json::json!({ "controller": self.controller.map(|id| id.to_string()), "epoch": self.control_epoch.to_string(), "sessions": members })).unwrap();
        self.roster.send_replace(Bytes::from(message));
    }

    pub(crate) fn expire_requests(&mut self) {
        let now = Instant::now();
        let mut changed = false;
        for p in self.participants.values_mut() {
            if p.request.as_ref().is_some_and(|r| now >= r.deadline) {
                p.request = None;
                p.request_result = Some("expired");
                changed = true;
            }
        }
        if changed { self.publish_roster(); }
    }

    pub(crate) fn end_requests(&mut self) {
        for p in self.participants.values_mut() {
            if p.request.take().is_some() { p.request_result = Some("controller_changed"); }
        }
    }
}

impl App {
    pub(crate) fn remove_viewers(&self, v: &mut Viewers, removed: &[u64]) {
        let previous_input = v.active_session();
        for id in removed { v.sessions.remove(id); }
        v.participants.retain(|id, p| {
            let mut remaining = v.sessions.iter().filter(|(_, s)| s.participant == *id && s.key.live());
            if !remaining.clone().any(|(id, _)| *id == p.active) {
                let Some((&next, _)) = remaining.next() else { return false; };
                p.active = next;
            }
            true
        });
        let next = v.controller.filter(|id| v.can_control(*id)).or_else(|| v.participants.keys().copied().filter(|id| v.can_control(*id)).min());
        self.update_controller(v, next, previous_input);
    }

    /// Called with the admitted caller and the viewers lock held.
    pub(crate) fn request_control(&self, v: &mut Viewers, id: u64) {
        v.expire_requests();
        let Some(s) = v.sessions.get(&id) else { return; };
        if !s.key.has(P::DesktopControl) {
            let _ = s.events.try_send(protocol::notice("This token does not allow desktop control."));
            return;
        }
        let participant = s.participant;
        if v.controller == Some(participant) { return; }
        if v.controller.is_none() { self.set_controller(v, Some(participant)); return; }
        let p = v.participants.get_mut(&participant).unwrap();
        if p.request.is_some() { return; }
        p.request = Some(ControlRequest { id: v.next_request, epoch: v.control_epoch, deadline: Instant::now() + Duration::from_secs(300), expires_at_ms: tokens::now_ms() + 300_000 });
        v.next_request += 1;
        p.request_result = None;
        v.publish_roster();
    }

    pub(crate) fn cancel_control(&self, v: &mut Viewers, id: u64, request: u64, epoch: u64) {
        v.expire_requests();
        if let Some(p) = v.participant_of(id).and_then(|id| v.participants.get_mut(&id)) {
            if p.request.as_ref().is_some_and(|r| r.id == request && r.epoch == epoch) {
                p.request = None;
                p.request_result = Some("cancelled");
                v.publish_roster();
            }
        }
    }

    pub(crate) fn decide_control(&self, v: &mut Viewers, id: u64, target: u64, request: u64, epoch: u64, approve: bool) {
        v.expire_requests();
        let valid = v.owns_control(id) && v.control_epoch == epoch && v.can_control(target)
            && v.participants.get(&target).is_some_and(|p| p.request.as_ref().is_some_and(|r| r.id == request && r.epoch == epoch));
        if !valid {
            if let Some(s) = v.sessions.get(&id) { let _ = s.events.try_send(protocol::notice("This control request is no longer pending.")); }
            return;
        }
        let p = v.participants.get_mut(&target).unwrap();
        p.request = None;
        p.request_result = Some(if approve { "approved" } else { "declined" });
        if approve { self.set_controller(v, Some(target)); } else { v.publish_roster(); }
    }
}
