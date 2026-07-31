pub(crate) mod pi_adapter;

use self::pi_adapter::{PiEventAdapter, PiEventContext, PiEventLane};
use crate::broker_ws::BrokerWs;
use crate::completion_coordinator::CompletionCoordinator;
use crate::completion_engine::{CompletionDecision, CompletionLevel};
use crate::context_engine::ContextEngine;
use crate::execution::TaskKind;
use crate::extension_manager::ExtensionManager;
use crate::harness_service::HarnessService;
use crate::hook_manager::HookManager;
use crate::pi_manager::PiManager;
use crate::resource_sampler::ProcessSampler;
use crate::runtime_coordinator::RuntimeTarget;
use crate::runtime_registry::{AgentRun, AgentRunState};
use crate::runtime_spine::{
    RuntimeEventInput, RuntimeEventKind, RuntimeSessionState, RuntimeSpine,
};
use crate::session_kernel::SessionKernel;
use crate::task_control::TaskControl;
use crate::work_manager::{WorkHandle, WorkKind, WorkManager, WorkStatus};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DEFAULT_MAILBOX_CAPACITY: usize = 256;

#[derive(Clone)]
pub(crate) struct RuntimeLifecycleDeps {
    pub broker: Arc<BrokerWs>,
    pub manager: Arc<PiManager>,
    pub task_control: Arc<Mutex<TaskControl>>,
    pub extension_manager: Arc<ExtensionManager>,
    pub work_manager: Arc<WorkManager>,
    pub session_kernel: Arc<Mutex<SessionKernel>>,
    pub runtime_spine: Arc<Mutex<RuntimeSpine>>,
    pub context_engine: Arc<ContextEngine>,
    pub harness_service: Arc<HarnessService>,
    pub hook_manager: Arc<HookManager>,
    pub completion_coordinator: Arc<CompletionCoordinator>,
}

pub(crate) struct RuntimeLifecycle {
    deps: RuntimeLifecycleDeps,
    mailboxes: Mutex<HashMap<RuntimeKey, RuntimeMailbox>>,
    instances: Mutex<HashMap<RuntimeKey, RuntimeSlot>>,
    completion_inflight: Mutex<HashSet<(String, String)>>,
    mailbox_capacity: usize,
}

#[derive(Clone, Copy, Debug, Eq)]
struct RuntimeKey {
    source_port: u16,
    process_id: u32,
}

#[derive(Clone)]
struct RuntimeSlot {
    target: RuntimeTarget,
    turn_ended: bool,
}

impl PartialEq for RuntimeKey {
    fn eq(&self, other: &Self) -> bool {
        self.source_port == other.source_port && self.process_id == other.process_id
    }
}

impl Hash for RuntimeKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.source_port.hash(state);
        self.process_id.hash(state);
    }
}

#[derive(Clone)]
struct PiEnvelope {
    source_port: u16,
    process_id: u32,
    payload: Value,
    lane: PiEventLane,
    coalesce_key: Option<String>,
}

struct RuntimeMailbox {
    draining: bool,
    queue: VecDeque<PiEnvelope>,
}

enum EnqueueOutcome {
    Drain,
    Queued,
    Coalesced,
}

impl RuntimeMailbox {
    fn new() -> Self {
        Self {
            draining: false,
            queue: VecDeque::new(),
        }
    }

    fn enqueue(&mut self, envelope: PiEnvelope, capacity: usize) -> Result<EnqueueOutcome, String> {
        if let Some(key) = envelope.coalesce_key.as_deref() {
            if let Some(existing) = self
                .queue
                .iter_mut()
                .rev()
                .find(|queued| queued.coalesce_key.as_deref() == Some(key))
            {
                *existing = envelope;
                return Ok(EnqueueOutcome::Coalesced);
            }
        }
        if self.queue.len() >= capacity {
            if envelope.lane == PiEventLane::CoalescibleProgress {
                return Ok(EnqueueOutcome::Coalesced);
            }
            if let Some(progress) = self
                .queue
                .iter()
                .position(|queued| queued.lane == PiEventLane::CoalescibleProgress)
            {
                self.queue.remove(progress);
            } else {
                return Err("runtime lifecycle mailbox is full of critical events".to_owned());
            }
        }
        self.queue.push_back(envelope);
        if self.draining {
            Ok(EnqueueOutcome::Queued)
        } else {
            self.draining = true;
            Ok(EnqueueOutcome::Drain)
        }
    }
}

impl RuntimeLifecycle {
    pub(crate) fn new(deps: RuntimeLifecycleDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            mailboxes: Mutex::new(HashMap::new()),
            instances: Mutex::new(HashMap::new()),
            completion_inflight: Mutex::new(HashSet::new()),
            mailbox_capacity: DEFAULT_MAILBOX_CAPACITY,
        })
    }

    pub(crate) fn install(self: &Arc<Self>) {
        let observer = self.clone();
        self.deps
            .broker
            .set_upstream_event_observer(Arc::new(move |source_port, payload| {
                if let Err(error) = observer.ingest_pi(source_port, payload) {
                    log::warn!("[runtime-lifecycle] Pi ingestion failed: {error}");
                }
            }));
        let monitor = self.clone();
        tauri::async_runtime::spawn(async move {
            monitor.run_resource_monitor().await;
        });
    }

    pub(crate) fn ingest_pi(
        self: &Arc<Self>,
        source_port: u16,
        payload: Value,
    ) -> Result<(), String> {
        let Some(process_id) = self.deps.manager.process_id(source_port) else {
            return Ok(());
        };
        let lane = PiEventAdapter::classify(&payload);
        if matches!(lane, PiEventLane::Streaming | PiEventLane::Ignored) {
            return self.project_streaming_event(&payload);
        }
        let key = RuntimeKey {
            source_port,
            process_id,
        };
        let coalesce_key =
            (lane == PiEventLane::CoalescibleProgress).then(|| progress_key(&payload));
        let envelope = PiEnvelope {
            source_port,
            process_id,
            payload,
            lane,
            coalesce_key,
        };
        let outcome = {
            let mut mailboxes = self
                .mailboxes
                .lock()
                .map_err(|_| "Runtime Lifecycle mailbox lock is poisoned".to_owned())?;
            mailboxes
                .entry(key)
                .or_insert_with(RuntimeMailbox::new)
                .enqueue(envelope, self.mailbox_capacity)
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                self.mark_current_reconciling(key);
                return Err(error);
            }
        };
        if !matches!(outcome, EnqueueOutcome::Drain) {
            return Ok(());
        }
        let mut first_error = None;
        loop {
            let next = {
                let mut mailboxes = self
                    .mailboxes
                    .lock()
                    .map_err(|_| "Runtime Lifecycle mailbox lock is poisoned".to_owned())?;
                let mailbox = mailboxes
                    .get_mut(&key)
                    .expect("draining mailbox must remain registered");
                match mailbox.queue.pop_front() {
                    Some(envelope) => Some(envelope),
                    None => {
                        mailbox.draining = false;
                        None
                    }
                }
            };
            let Some(envelope) = next else { break };
            if let Err(error) = self.process_pi_envelope(key, envelope) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn process_pi_envelope(
        self: &Arc<Self>,
        key: RuntimeKey,
        envelope: PiEnvelope,
    ) -> Result<(), String> {
        if envelope.lane == PiEventLane::CoalescibleProgress {
            return self.project_progress_event(&envelope);
        }
        let session_id = external_session_id(&envelope.payload);
        let workspace_id = envelope
            .payload
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let event_context = self
            .deps
            .task_control
            .lock()
            .map_err(|_| "Task Control lock is poisoned".to_owned())?
            .runtime_event_context(envelope.source_port);
        let target = self.runtime_target(
            key,
            &envelope.payload,
            workspace_id.as_deref(),
            session_id.as_deref(),
        )?;
        let context = PiEventContext {
            target: target.clone(),
            task_id: event_context
                .as_ref()
                .map(|context| context.task_id.clone()),
            agent_run_id: event_context
                .as_ref()
                .and_then(|context| context.active_run.as_ref().map(|run| run.id.clone())),
            parent_run_id: event_context
                .as_ref()
                .and_then(|context| context.parent_id.clone()),
            at: crate::unix_millis(),
        };
        let translation = PiEventAdapter::translate(&context, &envelope.payload);
        let Some(event) = translation.event else {
            return Ok(());
        };
        let event_id = event.event_id.clone();
        self.commit_event(&target, event)?;
        if event_is(&envelope.payload, "agent_end") {
            self.mark_turn_ended(key)?;
        }
        let observed = self.apply_projection(&target, &event_id, "task_control", || {
            self.deps
                .task_control
                .lock()
                .map_err(|_| "Task Control lock is poisoned".to_owned())?
                .observe_pi_event(
                    envelope.source_port,
                    envelope.process_id,
                    session_id.as_deref(),
                    &envelope.payload,
                )
        })?;
        let run = observed.or_else(|| self.latest_run(envelope.source_port));
        self.apply_projection(&target, &event_id, "context_engine", || {
            self.project_compaction(session_id.as_deref(), &envelope.payload)
        })?;
        self.apply_projection(&target, &event_id, "work_manager", || {
            self.project_work(run.as_ref(), &envelope.payload)
        })?;
        if event_is(&envelope.payload, "agent_end") {
            let Some(run) = run else {
                self.record_completion_outcome(
                    &target,
                    &event_id,
                    CompletionRecord {
                        task_id: None,
                        run_id: None,
                        outcome: CompletionOutcome::Passed,
                        complete_task: false,
                        follow_up_port: None,
                    },
                )?;
                self.mark_projection(&target, &event_id, "completion")?;
                return Ok(());
            };
            self.apply_projection(&target, &event_id, "extension_cleanup", || {
                self.deps.extension_manager.cancel_agent_processes(&run.id)
            })?;
            if run.parent_id.is_some() {
                self.apply_projection(&target, &event_id, "subagent_result", || {
                    self.complete_subagent(&run, &envelope.payload)
                })?;
                self.record_completion_outcome(
                    &target,
                    &event_id,
                    CompletionRecord {
                        task_id: Some(&run.task_id),
                        run_id: Some(&run.id),
                        outcome: CompletionOutcome::Passed,
                        complete_task: false,
                        follow_up_port: None,
                    },
                )?;
                self.mark_projection(&target, &event_id, "completion")?;
            } else {
                self.schedule_completion(target, event_id, run);
            }
        }
        Ok(())
    }

    fn project_streaming_event(&self, payload: &Value) -> Result<(), String> {
        let Some(session_id) = external_session_id(payload) else {
            return Ok(());
        };
        self.deps
            .session_kernel
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())?
            .observe_pi_event(
                &session_id,
                payload.get("workspaceId").and_then(Value::as_str),
                payload,
                crate::unix_millis(),
            )
            .map(|_| ())
    }

    fn project_progress_event(&self, envelope: &PiEnvelope) -> Result<(), String> {
        let session_id = external_session_id(&envelope.payload);
        let observed = self
            .deps
            .task_control
            .lock()
            .map_err(|_| "Task Control lock is poisoned".to_owned())?
            .observe_pi_event(
                envelope.source_port,
                envelope.process_id,
                session_id.as_deref(),
                &envelope.payload,
            )?;
        let run = observed.or_else(|| self.latest_run(envelope.source_port));
        self.project_work(run.as_ref(), &envelope.payload)
    }

    fn runtime_target(
        &self,
        key: RuntimeKey,
        payload: &Value,
        workspace_id: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<RuntimeTarget, String> {
        let starting = event_is(payload, "agent_start");
        let mut instances = self
            .instances
            .lock()
            .map_err(|_| "Runtime Lifecycle instance lock is poisoned".to_owned())?;
        if !starting {
            if let Some(slot) = instances.get(&key) {
                return Ok(slot.target.clone());
            }
        } else if let Some(slot) = instances.get(&key) {
            if !slot.turn_ended {
                return Ok(slot.target.clone());
            }
        }
        let target = RuntimeTarget::new(
            workspace_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("simple"),
            session_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("unbound-session"),
            format!(
                "pi-{}-{}-{}",
                key.source_port,
                key.process_id,
                uuid::Uuid::new_v4()
            ),
        );
        self.deps
            .runtime_spine
            .lock()
            .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
            .begin_session(target.clone())
            .map_err(|error| format!("begin Runtime Instance: {error:?}"))?;
        instances.insert(
            key,
            RuntimeSlot {
                target: target.clone(),
                turn_ended: false,
            },
        );
        Ok(target)
    }

    fn mark_turn_ended(&self, key: RuntimeKey) -> Result<(), String> {
        if let Some(slot) = self
            .instances
            .lock()
            .map_err(|_| "Runtime Lifecycle instance lock is poisoned".to_owned())?
            .get_mut(&key)
        {
            slot.turn_ended = true;
        }
        Ok(())
    }

    fn commit_event(&self, target: &RuntimeTarget, event: RuntimeEventInput) -> Result<(), String> {
        self.deps
            .runtime_spine
            .lock()
            .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
            .record(target, event)
            .map(|_| ())
            .map_err(|error| format!("commit Lifecycle Event: {error:?}"))
    }

    fn apply_projection<T>(
        &self,
        target: &RuntimeTarget,
        event_id: &str,
        projection: &str,
        apply: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String>
    where
        T: Default,
    {
        if self.projection_done(target, event_id, projection)? {
            return Ok(T::default());
        }
        match apply() {
            Ok(value) => {
                self.mark_projection(target, event_id, projection)?;
                Ok(value)
            }
            Err(error) => {
                self.deps
                    .runtime_spine
                    .lock()
                    .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
                    .mark_reconciling(target)
                    .map_err(|spine| format!("mark Runtime reconciling: {spine:?}"))?;
                Err(format!("projection {projection} failed: {error}"))
            }
        }
    }

    fn projection_done(
        &self,
        target: &RuntimeTarget,
        event_id: &str,
        projection: &str,
    ) -> Result<bool, String> {
        self.deps
            .runtime_spine
            .lock()
            .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
            .has_projection(target, event_id, projection)
            .map_err(|error| format!("read projection checkpoint: {error:?}"))
    }

    fn mark_projection(
        &self,
        target: &RuntimeTarget,
        event_id: &str,
        projection: &str,
    ) -> Result<(), String> {
        self.deps
            .runtime_spine
            .lock()
            .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
            .mark_projection(target, event_id, projection)
            .map(|_| ())
            .map_err(|error| format!("write projection checkpoint: {error:?}"))
    }

    fn project_compaction(&self, session_id: Option<&str>, payload: &Value) -> Result<(), String> {
        let Some(session_id) = session_id else {
            return Ok(());
        };
        let event = payload.get("event").unwrap_or(payload);
        match event.get("type").and_then(Value::as_str) {
            Some("auto_compaction_start") => self
                .deps
                .context_engine
                .observe_native_compaction(session_id, true, None, crate::unix_millis())
                .map(|_| ()),
            Some("auto_compaction_end") => self
                .deps
                .context_engine
                .observe_native_compaction(
                    session_id,
                    false,
                    Some(
                        !event
                            .get("summary")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value.starts_with("Error:")),
                    ),
                    crate::unix_millis(),
                )
                .map(|_| ()),
            _ => Ok(()),
        }
    }

    fn project_work(&self, run: Option<&AgentRun>, payload: &Value) -> Result<(), String> {
        let Some(run) = run else { return Ok(()) };
        self.deps
            .work_manager
            .upsert_external(agent_work_handle(run))?;
        if let Some(handle) = tool_work_handle(run, payload) {
            self.deps.work_manager.upsert_external(handle)?;
        }
        Ok(())
    }

    fn latest_run(&self, source_port: u16) -> Option<AgentRun> {
        self.deps.task_control.lock().ok().and_then(|control| {
            control
                .snapshot()
                .agent_runs
                .into_iter()
                .rev()
                .find(|run| run.source_port == source_port)
        })
    }

    fn complete_subagent(&self, run: &AgentRun, payload: &Value) -> Result<(), String> {
        let parent = self.deps.task_control.lock().ok().and_then(|control| {
            control
                .snapshot()
                .agent_runs
                .into_iter()
                .find(|candidate| Some(candidate.id.as_str()) == run.parent_id.as_deref())
        });
        if let Some(parent) = parent.filter(|parent| !parent.state.is_terminal()) {
            let summary = extract_subagent_candidate(payload);
            let advisory = self.deps.extension_manager.complete_advisory_for_process(
                run.source_port,
                &run.id,
                &summary,
            )?;
            let message = match advisory {
                Some(advisory) => format!(
                    "<picode-advisory-candidate advisoryId=\"{}\" childRunId=\"{}\">\nRole: {}\nModel: {}\n{}\n</picode-advisory-candidate>\nThis is a bounded read-only opinion, not evidence. Resolve conflicts yourself or ask the user.",
                    advisory.id, run.id, advisory.role, advisory.model, summary
                ),
                None => format!(
                    "<picode-subagent-candidate childRunId=\"{}\">\n{}\n</picode-subagent-candidate>\nReview this candidate against the parent task and effective Harness. Child completion is not verification.",
                    run.id, summary
                ),
            };
            self.deps.broker.send_command_to_port(
                parent.source_port,
                json!({ "type": "follow_up", "message": message }),
            )?;
        }
        self.deps.manager.kill(run.source_port);
        self.deps.broker.unregister_port(run.source_port);
        Ok(())
    }

    fn schedule_completion(
        self: &Arc<Self>,
        target: RuntimeTarget,
        source_event_id: String,
        run: AgentRun,
    ) {
        let key = (target.instance_id.clone(), source_event_id.clone());
        if !self
            .completion_inflight
            .lock()
            .map(|mut inflight| inflight.insert(key.clone()))
            .unwrap_or(false)
        {
            return;
        }
        let lifecycle = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = lifecycle
                .evaluate_completion(&target, &source_event_id, &run)
                .await;
            lifecycle
                .completion_inflight
                .lock()
                .ok()
                .map(|mut inflight| inflight.remove(&key));
            if let Err(error) = result {
                lifecycle.mark_target_reconciling(&target);
                log::warn!("[runtime-lifecycle] completion projection failed: {error}");
            }
        });
    }

    async fn evaluate_completion(
        &self,
        target: &RuntimeTarget,
        source_event_id: &str,
        run: &AgentRun,
    ) -> Result<(), String> {
        let task = {
            let control = self
                .deps
                .task_control
                .lock()
                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
            (
                control.task_kind(&run.task_id)?,
                control.task_working_dir(&run.task_id)?,
            )
        };
        let (outcome, mut complete_task) = match task.0 {
            // A Simple Task has no Completion Gate. The Runtime Instance may
            // settle, but the durable conversational Task Run remains ready
            // for another explicitly submitted turn.
            TaskKind::Simple => (CompletionOutcome::Passed, false),
            TaskKind::Harness => {
                let decision = self
                    .deps
                    .completion_coordinator
                    .evaluate(
                        &run.task_id,
                        &run.id,
                        &task.1,
                        &self.deps.harness_service,
                        &self.deps.hook_manager,
                    )
                    .await?;
                (completion_outcome(&decision), true)
            }
        };
        // A Gate result belongs to the Agent Run that requested it. If the
        // user already began a later turn, the older result may settle its
        // Runtime Instance but must not complete the still-active Task Run.
        if self
            .latest_run(run.source_port)
            .is_some_and(|latest| latest.id != run.id)
        {
            complete_task = false;
        }
        self.record_completion_outcome(
            target,
            source_event_id,
            CompletionRecord {
                task_id: Some(&run.task_id),
                run_id: Some(&run.id),
                outcome,
                complete_task,
                follow_up_port: Some(run.source_port),
            },
        )?;
        self.mark_projection(target, source_event_id, "completion")
    }

    fn record_completion_outcome(
        &self,
        target: &RuntimeTarget,
        source_event_id: &str,
        record: CompletionRecord<'_>,
    ) -> Result<(), String> {
        let (kind, status, blockers, completes_task) = match &record.outcome {
            CompletionOutcome::Passed => (RuntimeEventKind::CompletionPassed, "passed", 0, true),
            CompletionOutcome::Retry(decision) => (
                RuntimeEventKind::CompletionRetryRequested,
                "retry_requested",
                decision.blockers.len(),
                false,
            ),
            CompletionOutcome::Blocked(decision) => (
                RuntimeEventKind::CompletionBlocked,
                "waiting_for_user",
                decision.blockers.len(),
                false,
            ),
        };
        let event_id = format!("{source_event_id}:completion:{status}");
        self.commit_event(
            target,
            RuntimeEventInput {
                schema_version: 2,
                source: "picode".to_owned(),
                event_id: event_id.clone(),
                kind,
                task_id: record.task_id.map(str::to_owned),
                work_id: record.run_id.map(str::to_owned),
                parent_work_id: None,
                at: crate::unix_millis(),
                payload: json!({ "status": status, "itemCount": blockers }),
            },
        )?;
        match &record.outcome {
            CompletionOutcome::Passed => {
                if completes_task && record.complete_task {
                    let task_id = record.task_id.ok_or_else(|| {
                        "completion projection requires a Task Run identity".to_owned()
                    })?;
                    self.apply_projection(target, &event_id, "task_control_completion", || {
                        self.deps
                            .task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .complete_task(task_id)
                    })?;
                }
                self.deps
                    .runtime_spine
                    .lock()
                    .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
                    .set_session_state(target, RuntimeSessionState::Completed)
                    .map_err(|error| format!("complete Runtime Instance: {error:?}"))?;
            }
            CompletionOutcome::Retry(decision) => {
                let port = record
                    .follow_up_port
                    .ok_or_else(|| "completion retry has no owning Pi runtime".to_owned())?;
                let blockers = decision.blockers.join("\n- ");
                self.apply_projection(target, &event_id, "follow_up", || {
                    self.deps.broker.send_command_to_port(
                        port,
                        json!({
                            "type": "follow_up",
                            "lifecycleEventId": event_id,
                            "message": format!(
                                "Picode BeforeComplete Gate blocked completion. Fix the following bounded issues and retry:\n- {blockers}"
                            )
                        }),
                    )
                })?;
                self.deps
                    .runtime_spine
                    .lock()
                    .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
                    .set_session_state(target, RuntimeSessionState::Running)
                    .map_err(|error| format!("resume Runtime Instance: {error:?}"))?;
            }
            CompletionOutcome::Blocked(_) => {}
        }
        Ok(())
    }

    fn mark_current_reconciling(&self, key: RuntimeKey) {
        if let Ok(instances) = self.instances.lock() {
            if let Some(slot) = instances.get(&key) {
                self.mark_target_reconciling(&slot.target);
            }
        }
    }

    fn mark_target_reconciling(&self, target: &RuntimeTarget) {
        let _ = self
            .deps
            .runtime_spine
            .lock()
            .map_err(|_| ())
            .and_then(|mut spine| spine.mark_reconciling(target).map_err(|_| ()));
    }

    async fn run_resource_monitor(self: Arc<Self>) {
        let mut sampler = ProcessSampler::default();
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let runs = match self.deps.task_control.lock() {
                Ok(control) => control.snapshot().agent_runs,
                Err(_) => continue,
            };
            for run in runs.into_iter().filter(|run| !run.state.is_terminal()) {
                let _ = self
                    .deps
                    .work_manager
                    .upsert_external(agent_work_handle(&run));
                let at = crate::unix_millis();
                let owned = self
                    .deps
                    .manager
                    .owns_process(run.source_port, run.process_id);
                let sample = if owned {
                    sampler.sample(run.process_id, at).ok().map(|metric| {
                        crate::runtime_registry::ResourceSample {
                            at: metric.at,
                            cpu_percent: metric.cpu_percent,
                            memory_bytes: metric.memory_bytes,
                            uptime_ms: metric.uptime_ms,
                            attribution: metric.attribution,
                        }
                    })
                } else {
                    None
                };
                if let Ok(mut control) = self.deps.task_control.lock() {
                    if let Err(error) = control.sample_agent(&run.id, sample, owned, at) {
                        log::warn!(
                            "[runtime-lifecycle] sample rejected for {}: {}",
                            run.id,
                            error
                        );
                    }
                }
            }
        }
    }
}

#[derive(Clone)]
enum CompletionOutcome {
    Passed,
    Retry(CompletionDecision),
    Blocked(CompletionDecision),
}

struct CompletionRecord<'a> {
    task_id: Option<&'a str>,
    run_id: Option<&'a str>,
    outcome: CompletionOutcome,
    complete_task: bool,
    follow_up_port: Option<u16>,
}

fn completion_outcome(decision: &CompletionDecision) -> CompletionOutcome {
    if matches!(
        decision.level,
        CompletionLevel::HarnessVerified | CompletionLevel::CiVerified
    ) && decision.blockers.is_empty()
    {
        CompletionOutcome::Passed
    } else if decision.may_continue {
        CompletionOutcome::Retry(decision.clone())
    } else {
        CompletionOutcome::Blocked(decision.clone())
    }
}

fn external_session_id(payload: &Value) -> Option<String> {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| payload.get("sessionFile").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn event_is(payload: &Value, kind: &str) -> bool {
    payload
        .get("event")
        .unwrap_or(payload)
        .get("type")
        .and_then(Value::as_str)
        == Some(kind)
}

fn progress_key(payload: &Value) -> String {
    let event = payload.get("event").unwrap_or(payload);
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("progress");
    let work = event
        .get("toolCallId")
        .or_else(|| event.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("agent");
    format!("{kind}:{work}")
}

pub(crate) fn agent_work_handle(run: &AgentRun) -> WorkHandle {
    WorkHandle {
        id: run.id.clone(),
        component_id: None,
        owner_task_id: run.task_id.clone(),
        owner_run_id: run.id.clone(),
        parent_work_id: run.parent_id.clone(),
        kind: if run.parent_id.is_some() {
            WorkKind::Subagent
        } else {
            WorkKind::Agent
        },
        status: match run.state {
            AgentRunState::Completed => WorkStatus::Completed,
            AgentRunState::Failed => WorkStatus::Failed,
            AgentRunState::Cancelled => WorkStatus::Cancelled,
            AgentRunState::Terminated => WorkStatus::Terminated,
            _ => WorkStatus::Running,
        },
        process_id: Some(run.process_id),
        started_at: run.started_at,
        bounded_output: Vec::new(),
        output_artifact: None,
        termination_result: run.termination_result.clone(),
    }
}

fn tool_work_handle(run: &AgentRun, payload: &Value) -> Option<WorkHandle> {
    let event = payload.get("event").unwrap_or(payload);
    let event_type = event.get("type").and_then(Value::as_str)?;
    if !matches!(event_type, "tool_execution_start" | "tool_execution_end") {
        return None;
    }
    let tool_name = event
        .get("toolName")
        .or_else(|| event.get("tool"))
        .and_then(Value::as_str)?;
    let kind = match tool_name {
        "picode_shell" | "bash" | "shell" | "eval" => WorkKind::PersistentShell,
        "picode_browser" | "browser" => WorkKind::Server,
        "picode_lsp" => WorkKind::Lsp,
        _ => return None,
    };
    let call_id = event
        .get("toolCallId")
        .or_else(|| event.get("id"))
        .and_then(Value::as_str)?;
    let failed = event
        .get("error")
        .is_some_and(|value| !value.is_null() && value.as_str() != Some(""));
    Some(WorkHandle {
        id: format!("tool:{}:{call_id}", run.id),
        component_id: Some(
            match tool_name {
                "picode_lsp" => "rust-lsp",
                _ => tool_name,
            }
            .to_owned(),
        ),
        owner_task_id: run.task_id.clone(),
        owner_run_id: run.id.clone(),
        parent_work_id: Some(run.id.clone()),
        kind,
        status: match event_type {
            "tool_execution_start" => WorkStatus::Running,
            _ if failed => WorkStatus::Failed,
            _ => WorkStatus::Completed,
        },
        process_id: Some(run.process_id),
        started_at: event
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or_else(crate::unix_millis),
        bounded_output: Vec::new(),
        output_artifact: None,
        termination_result: failed.then(|| "tool execution failed".to_owned()),
    })
}

pub(crate) fn extract_subagent_candidate(payload: &Value) -> String {
    let event = payload.get("event").unwrap_or(payload);
    let mut last = None;
    if let Some(messages) = event.get("messages").and_then(Value::as_array) {
        for message in messages {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let text = match message.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            if !text.trim().is_empty() {
                last = Some(text);
            }
        }
    }
    let mut result =
        last.unwrap_or_else(|| "Subagent ended without a textual candidate result.".into());
    if result.len() > 32 * 1024 {
        result.truncate(32 * 1024);
        result.push_str("\n… bounded by Picode");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        completion_outcome, CompletionOutcome, EnqueueOutcome, PiEnvelope, RuntimeMailbox,
    };
    use crate::completion_engine::{CompletionDecision, CompletionLevel};
    use crate::runtime_lifecycle::pi_adapter::PiEventLane;
    use serde_json::json;

    fn envelope(kind: &str, lane: PiEventLane, key: Option<&str>) -> PiEnvelope {
        PiEnvelope {
            source_port: 1,
            process_id: 2,
            payload: json!({ "event": { "type": kind } }),
            lane,
            coalesce_key: key.map(str::to_owned),
        }
    }

    #[test]
    fn bounded_mailbox_coalesces_progress_but_rejects_critical_overflow() {
        let mut mailbox = RuntimeMailbox::new();
        assert!(matches!(
            mailbox.enqueue(
                envelope(
                    "message_update",
                    PiEventLane::CoalescibleProgress,
                    Some("run")
                ),
                1
            ),
            Ok(EnqueueOutcome::Drain)
        ));
        assert!(matches!(
            mailbox.enqueue(
                envelope(
                    "message_update",
                    PiEventLane::CoalescibleProgress,
                    Some("run")
                ),
                1
            ),
            Ok(EnqueueOutcome::Coalesced)
        ));
        assert!(mailbox
            .enqueue(envelope("agent_end", PiEventLane::Semantic, None), 1)
            .is_ok());
        let mut critical = RuntimeMailbox::new();
        critical
            .enqueue(envelope("agent_start", PiEventLane::Semantic, None), 1)
            .unwrap();
        assert!(critical
            .enqueue(envelope("agent_end", PiEventLane::Semantic, None), 1)
            .is_err());
    }

    #[test]
    fn only_verified_completion_is_terminal() {
        let retry = CompletionDecision {
            level: CompletionLevel::HarnessIncomplete,
            blockers: vec!["test failed".into()],
            flaky: false,
            may_continue: true,
        };
        assert!(matches!(
            completion_outcome(&retry),
            CompletionOutcome::Retry(_)
        ));
        let verified = CompletionDecision {
            level: CompletionLevel::HarnessVerified,
            blockers: Vec::new(),
            flaky: false,
            may_continue: false,
        };
        assert!(matches!(
            completion_outcome(&verified),
            CompletionOutcome::Passed
        ));
    }
}
