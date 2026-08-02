use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityState {
    Idle,
    Active,
    WaitingForUser,
    SuspectedStall,
    Terminal,
}

impl ActivityState {
    fn permits_takeover(self) -> bool {
        !matches!(self, Self::Active)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlState {
    Unowned,
    OwnedIdle,
    OwnedActive,
    Suspect,
    OrphanedActive,
    TakeoverAvailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientIdentity {
    pub client_id: String,
    pub surface: String,
    pub connection_id: u64,
}

impl ClientIdentity {
    pub fn new(client_id: &str, surface: &str, connection_id: u64) -> Result<Self, String> {
        if client_id.is_empty()
            || client_id.len() > 128
            || !client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-:".contains(&byte))
        {
            return Err("Invalid Conversation Control client ID".into());
        }
        if !matches!(surface, "gui" | "tui" | "headless" | "remote") {
            return Err("Invalid Conversation Control client surface".into());
        }
        if connection_id == 0 {
            return Err("Conversation Control connection ID must be non-zero".into());
        }
        Ok(Self {
            client_id: client_id.into(),
            surface: surface.into(),
            connection_id,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerView {
    pub client_id: String,
    pub surface: String,
    pub generation: u64,
    pub activity: ActivityState,
    pub selected: bool,
    pub connected: bool,
    pub lease_expires_at: u64,
    pub challenge_deadline: Option<u64>,
    pub last_progress_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlView {
    pub chat_id: String,
    pub state: ControlState,
    pub controller: Option<ControllerView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "decision", content = "control", rename_all = "snake_case")]
pub enum ClaimResult {
    Granted(ControlView),
    Observing(ControlView),
    Deferred(ControlView),
}

impl ClaimResult {
    pub fn granted_generation(&self) -> Option<u64> {
        match self {
            Self::Granted(view) => view
                .controller
                .as_ref()
                .map(|controller| controller.generation),
            Self::Observing(_) | Self::Deferred(_) => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Authorization {
    Authorized,
    Duplicate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseResult {
    Released,
    RetainedActive,
}

struct Owner {
    identity: ClientIdentity,
    generation: u64,
    activity: ActivityState,
    selected: bool,
    connected: bool,
    lease_expires_at: u64,
    challenge_deadline: Option<u64>,
    last_progress_at: u64,
}

impl Owner {
    fn view(&self) -> ControllerView {
        ControllerView {
            client_id: self.identity.client_id.clone(),
            surface: self.identity.surface.clone(),
            generation: self.generation,
            activity: self.activity,
            selected: self.selected,
            connected: self.connected,
            lease_expires_at: self.lease_expires_at,
            challenge_deadline: self.challenge_deadline,
            last_progress_at: self.last_progress_at,
        }
    }
}

#[derive(Default)]
struct ChatControl {
    generation: u64,
    owner: Option<Owner>,
    seen_order: VecDeque<String>,
    seen_requests: HashSet<String>,
}

pub struct ConversationControl {
    chats: HashMap<String, ChatControl>,
    lease_ms: u64,
    challenge_ms: u64,
    retained_requests: usize,
}

impl ConversationControl {
    pub fn new(lease_ms: u64, challenge_ms: u64, retained_requests: usize) -> Self {
        Self {
            chats: HashMap::new(),
            lease_ms: lease_ms.max(100),
            challenge_ms: challenge_ms.max(50),
            retained_requests: retained_requests.clamp(16, 16_384),
        }
    }

    pub fn observe(&mut self, chat_id: &str, now: u64) -> ControlView {
        if !valid_chat_id(chat_id) {
            return ControlView {
                chat_id: chat_id.into(),
                state: ControlState::Unowned,
                controller: None,
            };
        }
        let Some(record) = self.chats.get_mut(chat_id) else {
            return ControlView {
                chat_id: chat_id.into(),
                state: ControlState::Unowned,
                controller: None,
            };
        };
        view_record(chat_id, record, now, self.challenge_ms)
    }

    pub fn snapshot(&mut self, now: u64) -> Vec<ControlView> {
        let challenge_ms = self.challenge_ms;
        let mut views = self
            .chats
            .iter_mut()
            .filter_map(|(chat_id, record)| {
                if record.owner.is_some() {
                    Some(view_record(chat_id, record, now, challenge_ms))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.chat_id.cmp(&right.chat_id));
        views
    }

    pub fn claim(
        &mut self,
        chat_id: &str,
        identity: &ClientIdentity,
        now: u64,
    ) -> Result<ClaimResult, String> {
        validate_chat_id(chat_id)?;
        let record = self.chats.entry(chat_id.into()).or_default();
        let state = view_record(chat_id, record, now, self.challenge_ms).state;
        if let Some(owner) = record.owner.as_mut() {
            if owner.identity == *identity && owner.connected {
                owner.selected = true;
                owner.lease_expires_at = now.saturating_add(self.lease_ms);
                owner.challenge_deadline = None;
                return Ok(ClaimResult::Granted(view_record(
                    chat_id,
                    record,
                    now,
                    self.challenge_ms,
                )));
            }
        }
        if record.owner.is_none() || state == ControlState::TakeoverAvailable {
            grant(record, identity, now, self.lease_ms);
            return Ok(ClaimResult::Granted(view_record(
                chat_id,
                record,
                now,
                self.challenge_ms,
            )));
        }
        let view = view_record(chat_id, record, now, self.challenge_ms);
        if state == ControlState::OrphanedActive {
            Ok(ClaimResult::Deferred(view))
        } else {
            Ok(ClaimResult::Observing(view))
        }
    }

    pub fn renew(
        &mut self,
        chat_id: &str,
        identity: &ClientIdentity,
        generation: u64,
        now: u64,
    ) -> Result<ControlView, String> {
        let record = self
            .chats
            .get_mut(chat_id)
            .ok_or("Conversation has no controller")?;
        let owner = matching_owner(record, identity, generation)?;
        owner.connected = true;
        owner.lease_expires_at = now.saturating_add(self.lease_ms);
        owner.challenge_deadline = None;
        Ok(view_record(chat_id, record, now, self.challenge_ms))
    }

    pub fn probe_failed(&mut self, chat_id: &str, now: u64) -> Result<ControlView, String> {
        let record = self
            .chats
            .get_mut(chat_id)
            .ok_or("Conversation has no controller")?;
        let owner = record
            .owner
            .as_mut()
            .ok_or("Conversation has no controller")?;
        let deadline = owner
            .challenge_deadline
            .ok_or("Conversation controller is not awaiting a probe")?;
        if now < deadline {
            return Err("Conversation controller probe deadline has not elapsed".into());
        }
        owner.connected = false;
        owner.selected = false;
        Ok(view_record(chat_id, record, now, self.challenge_ms))
    }

    pub fn release(
        &mut self,
        chat_id: &str,
        identity: &ClientIdentity,
        generation: u64,
        _now: u64,
    ) -> Result<ReleaseResult, String> {
        let record = self
            .chats
            .get_mut(chat_id)
            .ok_or("Conversation has no controller")?;
        let owner = matching_owner(record, identity, generation)?;
        if owner.activity == ActivityState::Active {
            owner.selected = false;
            return Ok(ReleaseResult::RetainedActive);
        }
        record.owner = None;
        Ok(ReleaseResult::Released)
    }

    pub fn disconnect_connection(&mut self, connection_id: u64, now: u64) {
        for record in self.chats.values_mut() {
            if let Some(owner) = record
                .owner
                .as_mut()
                .filter(|owner| owner.identity.connection_id == connection_id)
            {
                owner.selected = false;
                if owner.activity == ActivityState::Active {
                    owner.connected = false;
                    owner.challenge_deadline = None;
                } else {
                    // A socket disappearing is ambiguous: the peer may be
                    // partitioned while its process is still alive. Expire the
                    // lease and require the normal challenge/probe path. An
                    // orderly route switch calls release() explicitly instead.
                    owner.lease_expires_at = now.saturating_sub(1);
                    owner.challenge_deadline = Some(now.saturating_add(self.challenge_ms));
                }
            }
        }
    }

    pub fn record_activity(
        &mut self,
        chat_id: &str,
        activity: ActivityState,
        now: u64,
    ) -> Result<ControlView, String> {
        let record = self
            .chats
            .get_mut(chat_id)
            .ok_or("Conversation has no controller")?;
        let owner = record
            .owner
            .as_mut()
            .ok_or("Conversation has no controller")?;
        owner.activity = activity;
        owner.last_progress_at = now;
        if activity == ActivityState::Active && owner.connected {
            owner.lease_expires_at = now.saturating_add(self.lease_ms);
            owner.challenge_deadline = None;
        }
        if activity.permits_takeover() && (!owner.connected || !owner.selected) {
            record.owner = None;
        }
        Ok(view_record(chat_id, record, now, self.challenge_ms))
    }

    pub fn authorize(
        &mut self,
        chat_id: &str,
        identity: &ClientIdentity,
        generation: u64,
        request_id: &str,
        now: u64,
    ) -> Result<Authorization, String> {
        validate_chat_id(chat_id)?;
        if request_id.is_empty() || request_id.len() > 256 {
            return Err("Mutation request ID must contain 1 to 256 characters".into());
        }
        let record = self
            .chats
            .get_mut(chat_id)
            .ok_or("Conversation has no controller")?;
        if record.seen_requests.contains(request_id) {
            return Ok(Authorization::Duplicate);
        }
        let state = view_record(chat_id, record, now, self.challenge_ms).state;
        let owner = record
            .owner
            .as_ref()
            .ok_or("Conversation has no controller")?;
        if owner.generation != generation {
            return Err(format!(
                "Stale Conversation Control generation {generation}; current generation is {}",
                owner.generation
            ));
        }
        if owner.identity != *identity {
            return Err("Only the current conversation controller can mutate this chat".into());
        }
        if !matches!(state, ControlState::OwnedIdle | ControlState::OwnedActive) {
            return Err("Conversation controller lease is not healthy".into());
        }
        record.seen_requests.insert(request_id.into());
        record.seen_order.push_back(request_id.into());
        while record.seen_order.len() > self.retained_requests {
            if let Some(expired) = record.seen_order.pop_front() {
                record.seen_requests.remove(&expired);
            }
        }
        Ok(Authorization::Authorized)
    }
}

fn grant(record: &mut ChatControl, identity: &ClientIdentity, now: u64, lease_ms: u64) {
    record.generation = record.generation.saturating_add(1).max(1);
    record.owner = Some(Owner {
        identity: identity.clone(),
        generation: record.generation,
        activity: ActivityState::Idle,
        selected: true,
        connected: true,
        lease_expires_at: now.saturating_add(lease_ms),
        challenge_deadline: None,
        last_progress_at: now,
    });
}

fn matching_owner<'a>(
    record: &'a mut ChatControl,
    identity: &ClientIdentity,
    generation: u64,
) -> Result<&'a mut Owner, String> {
    let owner = record
        .owner
        .as_mut()
        .ok_or("Conversation has no controller")?;
    if owner.generation != generation {
        return Err("Stale Conversation Control generation".into());
    }
    if owner.identity != *identity {
        return Err("Only the current conversation controller may renew or release".into());
    }
    Ok(owner)
}

fn view_record(
    chat_id: &str,
    record: &mut ChatControl,
    now: u64,
    challenge_ms: u64,
) -> ControlView {
    let state = match record.owner.as_mut() {
        None => ControlState::Unowned,
        Some(owner) if !owner.connected => {
            if owner.activity.permits_takeover() {
                ControlState::TakeoverAvailable
            } else {
                ControlState::OrphanedActive
            }
        }
        Some(owner) if now > owner.lease_expires_at => {
            if owner.challenge_deadline.is_none() {
                owner.challenge_deadline = Some(now.saturating_add(challenge_ms));
            }
            ControlState::Suspect
        }
        Some(owner) if owner.activity == ActivityState::Active => ControlState::OwnedActive,
        Some(_) => ControlState::OwnedIdle,
    };
    ControlView {
        chat_id: chat_id.into(),
        state,
        controller: record.owner.as_ref().map(Owner::view),
    }
}

fn valid_chat_id(chat_id: &str) -> bool {
    !chat_id.trim().is_empty()
        && chat_id.len() <= 4096
        && !chat_id.chars().any(|character| character == '\0')
}

fn validate_chat_id(chat_id: &str) -> Result<(), String> {
    if valid_chat_id(chat_id) {
        Ok(())
    } else {
        Err("Chat ID must contain 1 to 4096 non-NUL characters".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ActivityState, Authorization, ClaimResult, ClientIdentity, ControlState,
        ConversationControl, ReleaseResult,
    };

    fn client(id: &str, connection_id: u64) -> ClientIdentity {
        ClientIdentity::new(id, "gui", connection_id).unwrap()
    }

    fn surface_client(id: &str, surface: &str, connection_id: u64) -> ClientIdentity {
        ClientIdentity::new(id, surface, connection_id).unwrap()
    }

    #[test]
    fn concurrent_claims_elect_one_controller_and_fence_every_mutation() {
        let mut control = ConversationControl::new(1_000, 250, 64);
        let a = client("gui-a", 1);
        let b = client("tui-b", 2);

        let first = control.claim("chat-a", &a, 100).unwrap();
        let generation = first.granted_generation().unwrap();
        assert!(matches!(
            control.claim("chat-a", &b, 101).unwrap(),
            ClaimResult::Observing(_)
        ));
        assert_eq!(
            control.observe("chat-a", 101).state,
            ControlState::OwnedIdle
        );

        assert_eq!(
            control
                .authorize("chat-a", &a, generation, "request-a", 102)
                .unwrap(),
            Authorization::Authorized
        );
        assert_eq!(
            control
                .authorize("chat-a", &a, generation, "request-a", 103)
                .unwrap(),
            Authorization::Duplicate
        );
        assert!(control
            .authorize("chat-a", &b, generation, "request-b", 104)
            .unwrap_err()
            .contains("controller"));
    }

    #[test]
    fn failed_active_controller_cannot_be_stolen_until_a_safe_runtime_state() {
        let mut control = ConversationControl::new(1_000, 250, 64);
        let a = client("gui-a", 1);
        let b = client("tui-b", 2);
        let generation = control
            .claim("chat-a", &a, 100)
            .unwrap()
            .granted_generation()
            .unwrap();
        control
            .record_activity("chat-a", ActivityState::Active, 110)
            .unwrap();
        control.disconnect_connection(1, 120);

        assert_eq!(
            control.observe("chat-a", 121).state,
            ControlState::OrphanedActive
        );
        assert!(matches!(
            control.claim("chat-a", &b, 122).unwrap(),
            ClaimResult::Deferred(_)
        ));
        assert!(control
            .authorize("chat-a", &a, generation, "stale-a", 123)
            .is_err());

        control
            .record_activity("chat-a", ActivityState::WaitingForUser, 130)
            .unwrap();
        let next = control.claim("chat-a", &b, 131).unwrap();
        assert!(next.granted_generation().unwrap() > generation);
    }

    #[test]
    fn timeout_requires_failed_probe_and_safe_activity_before_takeover() {
        let mut control = ConversationControl::new(100, 50, 64);
        let a = client("gui-a", 1);
        let b = client("tui-b", 2);
        control.claim("chat-a", &a, 100).unwrap();

        assert_eq!(control.observe("chat-a", 201).state, ControlState::Suspect);
        assert!(matches!(
            control.claim("chat-a", &b, 220).unwrap(),
            ClaimResult::Observing(_)
        ));
        control.probe_failed("chat-a", 251).unwrap();
        assert_eq!(
            control.observe("chat-a", 251).state,
            ControlState::TakeoverAvailable
        );
        assert!(control
            .claim("chat-a", &b, 252)
            .unwrap()
            .granted_generation()
            .is_some());
    }

    #[test]
    fn ambiguous_idle_disconnect_requires_a_failed_probe_before_takeover() {
        let mut control = ConversationControl::new(100, 50, 64);
        let a = client("gui-a", 1);
        let b = client("tui-b", 2);
        control.claim("chat-a", &a, 100).unwrap();

        control.disconnect_connection(1, 120);
        assert_eq!(control.observe("chat-a", 121).state, ControlState::Suspect);
        assert!(matches!(
            control.claim("chat-a", &b, 130).unwrap(),
            ClaimResult::Observing(_)
        ));
        assert!(control.probe_failed("chat-a", 160).is_err());
        control.probe_failed("chat-a", 171).unwrap();
        assert!(control
            .claim("chat-a", &b, 172)
            .unwrap()
            .granted_generation()
            .is_some());
    }

    #[test]
    fn switching_away_retains_active_run_then_releases_at_safe_transition() {
        let mut control = ConversationControl::new(1_000, 250, 64);
        let a = client("gui-a", 1);
        let generation = control
            .claim("chat-a", &a, 100)
            .unwrap()
            .granted_generation()
            .unwrap();
        control
            .record_activity("chat-a", ActivityState::Active, 110)
            .unwrap();
        assert_eq!(
            control.release("chat-a", &a, generation, 120).unwrap(),
            ReleaseResult::RetainedActive
        );
        control
            .record_activity("chat-a", ActivityState::Terminal, 130)
            .unwrap();
        assert_eq!(control.observe("chat-a", 131).state, ControlState::Unowned);
    }

    #[test]
    fn stale_generation_is_rejected_after_safe_takeover() {
        let mut control = ConversationControl::new(1_000, 250, 64);
        let a = client("gui-a", 1);
        let b = client("tui-b", 2);
        let old = control
            .claim("chat-a", &a, 100)
            .unwrap()
            .granted_generation()
            .unwrap();
        control.disconnect_connection(1, 110);
        assert_eq!(control.observe("chat-a", 111).state, ControlState::Suspect);
        control.probe_failed("chat-a", 361).unwrap();
        let new = control
            .claim("chat-a", &b, 362)
            .unwrap()
            .granted_generation()
            .unwrap();

        assert!(new > old);
        assert!(control
            .authorize("chat-a", &a, old, "late-old", 363)
            .unwrap_err()
            .contains("generation"));
    }

    #[test]
    fn lost_acknowledgement_cannot_replay_after_a_cross_surface_takeover() {
        let mut control = ConversationControl::new(100, 50, 64);
        let gui = surface_client("gui-a", "gui", 1);
        let tui = surface_client("tui-b", "tui", 2);
        let remote = surface_client("remote-c", "remote", 3);
        let old = control
            .claim("chat-a", &gui, 100)
            .unwrap()
            .granted_generation()
            .unwrap();
        assert_eq!(
            control
                .authorize("chat-a", &gui, old, "lost-ack-request", 101)
                .unwrap(),
            Authorization::Authorized
        );
        assert!(matches!(
            control.claim("chat-a", &remote, 102).unwrap(),
            ClaimResult::Observing(_)
        ));

        control.disconnect_connection(1, 110);
        control.probe_failed("chat-a", 161).unwrap();
        let new = control
            .claim("chat-a", &tui, 162)
            .unwrap()
            .granted_generation()
            .unwrap();
        assert!(new > old);
        assert_eq!(
            control
                .authorize("chat-a", &gui, old, "lost-ack-request", 163)
                .unwrap(),
            Authorization::Duplicate
        );
        assert!(control
            .authorize("chat-a", &remote, new, "remote-write", 164)
            .unwrap_err()
            .contains("controller"));
    }

    #[test]
    fn core_restart_drops_only_volatile_control_leases() {
        let gui = client("gui-a", 1);
        let mut before = ConversationControl::new(1_000, 250, 64);
        before.claim("durable-chat-id", &gui, 100).unwrap();
        assert_eq!(before.snapshot(101).len(), 1);

        let mut after = ConversationControl::new(1_000, 250, 64);
        assert!(after.snapshot(101).is_empty());
        assert_eq!(
            after.observe("durable-chat-id", 101).state,
            ControlState::Unowned
        );
    }
}
