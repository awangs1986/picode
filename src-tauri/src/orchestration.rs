// This module is the executable orchestration contract. Integration and
// terminal variants are preserved for durable records across platforms.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StageStatus {
    Pending,
    Running,
    Blocked,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub dependencies: Vec<String>,
    pub owner: String,
    pub status: StageStatus,
    pub evidence: Vec<String>,
    pub blockers: Vec<String>,
}

impl Stage {
    pub fn new(id: &str, dependencies: &[&str], owner: &str) -> Self {
        Self {
            id: id.into(),
            dependencies: dependencies
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            owner: owner.into(),
            status: StageStatus::Pending,
            evidence: Vec::new(),
            blockers: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRevision {
    pub sequence: u32,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraph {
    pub task_id: String,
    pub stages: Vec<Stage>,
    pub revisions: Vec<GraphRevision>,
}

impl TaskGraph {
    pub fn new(task_id: &str) -> Self {
        Self {
            task_id: task_id.into(),
            stages: Vec::new(),
            revisions: Vec::new(),
        }
    }
    pub fn add_stage(&mut self, stage: Stage) -> Result<(), String> {
        if stage.id.trim().is_empty() || stage.owner.trim().is_empty() {
            return Err("stage id and owner are required".into());
        }
        if self.stages.iter().any(|existing| existing.id == stage.id) {
            return Err("stage already exists".into());
        }
        for dependency in &stage.dependencies {
            if !self
                .stages
                .iter()
                .any(|existing| existing.id == *dependency)
            {
                return Err(format!("missing stage dependency {dependency}"));
            }
        }
        self.stages.push(stage);
        self.revisions.push(GraphRevision {
            sequence: self.revisions.len() as u32 + 1,
            reason: "stage added".into(),
        });
        Ok(())
    }
    pub fn complete(&mut self, id: &str, evidence: &[&str]) -> Result<(), String> {
        let completed: BTreeSet<String> = self
            .stages
            .iter()
            .filter(|stage| stage.status == StageStatus::Completed)
            .map(|stage| stage.id.clone())
            .collect();
        let stage = self
            .stages
            .iter_mut()
            .find(|stage| stage.id == id)
            .ok_or_else(|| "stage missing".to_owned())?;
        if stage
            .dependencies
            .iter()
            .any(|dependency| !completed.contains(dependency))
        {
            return Err("stage dependencies are incomplete".into());
        }
        stage.status = StageStatus::Completed;
        stage
            .evidence
            .extend(evidence.iter().map(|value| (*value).to_owned()));
        self.revisions.push(GraphRevision {
            sequence: self.revisions.len() as u32 + 1,
            reason: format!("stage {id} completed"),
        });
        Ok(())
    }
    pub fn ready(&self) -> Vec<String> {
        let completed: BTreeSet<&str> = self
            .stages
            .iter()
            .filter(|stage| stage.status == StageStatus::Completed)
            .map(|stage| stage.id.as_str())
            .collect();
        self.stages
            .iter()
            .filter(|stage| {
                stage.status == StageStatus::Pending
                    && stage.blockers.is_empty()
                    && stage
                        .dependencies
                        .iter()
                        .all(|dependency| completed.contains(dependency.as_str()))
            })
            .map(|stage| stage.id.clone())
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPackage {
    pub schema_version: u32,
    pub goal: String,
    pub constraints: Vec<String>,
    pub graph: TaskGraph,
    pub workspace_facts: BTreeMap<String, String>,
    pub created_from_deterministic_state: bool,
}

impl CheckpointPackage {
    pub fn build(
        goal: &str,
        constraints: &[&str],
        graph: &TaskGraph,
        workspace_facts: BTreeMap<String, String>,
        known_secret_values: &[String],
    ) -> Result<Self, String> {
        let candidate = Self {
            schema_version: 1,
            goal: goal.into(),
            constraints: constraints
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            graph: graph.clone(),
            workspace_facts,
            created_from_deterministic_state: true,
        };
        let encoded = serde_json::to_string(&candidate)
            .map_err(|error| format!("serialize checkpoint: {error}"))?;
        if known_secret_values
            .iter()
            .any(|secret| !secret.is_empty() && encoded.contains(secret))
        {
            return Err("checkpoint contains a secret value".into());
        }
        Ok(candidate)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WriteLease {
    pub run_id: String,
    pub physical_path: PathBuf,
    pub acquired_at: u64,
}

#[derive(Default)]
pub struct WriteLeaseManager {
    leases: Vec<WriteLease>,
}

impl WriteLeaseManager {
    pub fn acquire(
        &mut self,
        run_id: &str,
        workspace: &Path,
        at: u64,
    ) -> Result<WriteLease, String> {
        let physical_path = workspace
            .canonicalize()
            .map_err(|error| format!("resolve workspace for lease: {error}"))?;
        if self
            .leases
            .iter()
            .any(|lease| same_physical_path(&lease.physical_path, &physical_path))
        {
            return Err("workspace already has a managed writer".into());
        }
        let lease = WriteLease {
            run_id: run_id.into(),
            physical_path,
            acquired_at: at,
        };
        self.leases.push(lease.clone());
        Ok(lease)
    }
    pub fn reconcile<F>(&mut self, run_alive: F)
    where
        F: Fn(&str) -> bool,
    {
        self.leases.retain(|lease| run_alive(&lease.run_id));
    }
}

fn same_physical_path(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Terminated,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackgroundJob {
    pub id: String,
    pub task_id: String,
    pub agent_run_id: String,
    pub process_id: u32,
    pub started_at: u64,
    pub status: JobStatus,
    pub live_tail: Vec<u8>,
    pub full_output_hash: String,
    pub termination_result: Option<String>,
}

struct BackgroundJobRecord {
    job: BackgroundJob,
    hasher: Sha256,
}

pub struct BackgroundJobManager {
    tail_bytes: usize,
    jobs: BTreeMap<String, BackgroundJobRecord>,
}

impl BackgroundJobManager {
    pub fn new(tail_bytes: usize) -> Self {
        Self {
            tail_bytes,
            jobs: BTreeMap::new(),
        }
    }
    pub fn start(
        &mut self,
        task_id: &str,
        agent_run_id: &str,
        process_id: u32,
        at: u64,
    ) -> Result<BackgroundJob, String> {
        if task_id.trim().is_empty() || agent_run_id.trim().is_empty() || process_id == 0 {
            return Err("background job identity is required".into());
        }
        let id = Uuid::new_v4().to_string();
        let hasher = Sha256::new();
        let job = BackgroundJob {
            id: id.clone(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            process_id,
            started_at: at,
            status: JobStatus::Running,
            live_tail: Vec::new(),
            full_output_hash: digest_snapshot(&hasher),
            termination_result: None,
        };
        self.jobs.insert(
            id,
            BackgroundJobRecord {
                job: job.clone(),
                hasher,
            },
        );
        Ok(job)
    }
    pub fn get(&self, id: &str) -> Option<&BackgroundJob> {
        self.jobs.get(id).map(|record| &record.job)
    }
    pub fn append_output(&mut self, id: &str, output: &[u8]) -> Result<(), String> {
        let record = self
            .jobs
            .get_mut(id)
            .ok_or_else(|| "background job missing".to_owned())?;
        if record.job.status != JobStatus::Running {
            return Err("background job is terminal".into());
        }
        record.hasher.update(output);
        record.job.full_output_hash = digest_snapshot(&record.hasher);
        record.job.live_tail.extend_from_slice(output);
        if record.job.live_tail.len() > self.tail_bytes {
            let overflow = record.job.live_tail.len() - self.tail_bytes;
            record.job.live_tail.drain(..overflow);
        }
        Ok(())
    }
    pub fn reconcile_after_restart<F>(&mut self, process_alive: F, _at: u64)
    where
        F: Fn(u32) -> bool,
    {
        for record in self.jobs.values_mut() {
            if record.job.status == JobStatus::Running && !process_alive(record.job.process_id) {
                record.job.status = JobStatus::Terminated;
                record.job.termination_result = Some("process unavailable after restart".into());
            }
        }
    }
}

fn digest_snapshot(hasher: &Sha256) -> String {
    hasher
        .clone()
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationEnvelope {
    pub goal: String,
    pub scope: Vec<String>,
    pub method: String,
    pub tools: BTreeSet<String>,
    pub permissions: BTreeSet<String>,
    pub context: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub expected_result: String,
}

impl DelegationEnvelope {
    fn is_complete(&self) -> bool {
        !self.goal.trim().is_empty()
            && !self.scope.is_empty()
            && !self.method.trim().is_empty()
            && !self.tools.is_empty()
            && !self.context.is_empty()
            && !self.stop_conditions.is_empty()
            && !self.expected_result.trim().is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatedWork {
    pub class: String,
    pub envelope: DelegationEnvelope,
    pub requires_write: bool,
    pub uses_secret: bool,
    pub destructive: bool,
    pub ambiguous: bool,
    pub independently_verifiable: bool,
    pub context_bytes: usize,
}

impl DelegatedWork {
    pub fn read_only_search(class: &str, envelope: DelegationEnvelope) -> Self {
        Self {
            class: class.into(),
            envelope,
            requires_write: false,
            uses_secret: false,
            destructive: false,
            ambiguous: false,
            independently_verifiable: true,
            context_bytes: 4096,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Eligibility {
    Eligible,
    Rejected(String),
}

pub fn delegation_eligibility(work: &DelegatedWork) -> Eligibility {
    if !work.envelope.is_complete() {
        return Eligibility::Rejected("delegation envelope is incomplete".into());
    }
    if work.requires_write {
        return Eligibility::Rejected("writes are not eligible".into());
    }
    if work.uses_secret {
        return Eligibility::Rejected("secret use is not eligible".into());
    }
    if work.destructive {
        return Eligibility::Rejected("destructive work is not eligible".into());
    }
    if work.ambiguous {
        return Eligibility::Rejected("ambiguous work is not eligible".into());
    }
    if !work.independently_verifiable {
        return Eligibility::Rejected("unverifiable work is not eligible".into());
    }
    if work.context_bytes > 64 * 1024 {
        return Eligibility::Rejected("context is too large".into());
    }
    Eligibility::Eligible
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub id: String,
    pub capability: u32,
    pub quality: u32,
    pub cost_rank: u32,
    pub healthy: bool,
}

impl ModelCandidate {
    pub fn new(id: &str, capability: u32, quality: u32, cost_rank: u32, healthy: bool) -> Self {
        Self {
            id: id.into(),
            capability,
            quality,
            cost_rank,
            healthy,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelFallback {
    DoNotDelegate,
    InheritMain,
    Ask,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentModelPolicy {
    pub candidates: Vec<ModelCandidate>,
    pub fallback: ModelFallback,
}

#[derive(Clone, Debug, Default)]
pub struct RoutingEvaluations {
    qualified: BTreeSet<(String, String)>,
}

impl RoutingEvaluations {
    pub fn qualified(class: &str, models: &[&str]) -> Self {
        Self {
            qualified: models
                .iter()
                .map(|model| (class.to_owned(), (*model).to_owned()))
                .collect(),
        }
    }
    pub fn from_qualified(class: &str, models: &[String]) -> Self {
        Self {
            qualified: models
                .iter()
                .map(|model| (class.to_owned(), model.clone()))
                .collect(),
        }
    }
    fn permits(&self, class: &str, model: &str) -> bool {
        self.qualified
            .contains(&(class.to_owned(), model.to_owned()))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDecision {
    pub model_id: String,
    pub reason: String,
    pub fallback: ModelFallback,
    pub envelope: DelegationEnvelope,
}

pub fn route_delegation(
    work: &DelegatedWork,
    policy: &SubagentModelPolicy,
    evaluations: &RoutingEvaluations,
) -> Result<RoutingDecision, String> {
    if delegation_eligibility(work) != Eligibility::Eligible {
        return Err("work is ineligible for delegation".into());
    }
    let mut candidates: Vec<_> = policy
        .candidates
        .iter()
        .filter(|candidate| candidate.healthy && evaluations.permits(&work.class, &candidate.id))
        .collect();
    candidates.sort_by(|left, right| {
        right
            .capability
            .cmp(&left.capability)
            .then_with(|| right.quality.cmp(&left.quality))
            .then_with(|| left.cost_rank.cmp(&right.cost_rank))
            .then_with(|| left.id.cmp(&right.id))
    });
    let selected = candidates.first().ok_or_else(|| {
        match policy.fallback {
            ModelFallback::DoNotDelegate => "no qualified model; do not delegate",
            ModelFallback::InheritMain => "no qualified model; inherit main model",
            ModelFallback::Ask => "no qualified model; ask user",
        }
        .to_owned()
    })?;
    Ok(RoutingDecision {
        model_id: selected.id.clone(),
        reason: format!(
            "selected by capability {}, measured quality {}, then cost rank {}",
            selected.capability, selected.quality, selected.cost_rank
        ),
        fallback: policy.fallback,
        envelope: work.envelope.clone(),
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubagentRun {
    pub id: String,
    pub parent_id: String,
    pub decision: RoutingDecision,
    pub result: Option<String>,
    pub evidence: Vec<String>,
}

impl SubagentRun {
    pub fn spawn(
        parent_id: &str,
        decision: RoutingDecision,
        parent_is_subagent: bool,
    ) -> Result<Self, String> {
        if parent_is_subagent {
            return Err("nested Subagents are disabled by default".into());
        }
        if !decision.envelope.is_complete() {
            return Err("delegation envelope is incomplete".into());
        }
        Ok(Self {
            id: Uuid::new_v4().to_string(),
            parent_id: parent_id.into(),
            decision,
            result: None,
            evidence: Vec::new(),
        })
    }
    pub fn finish(mut self, result: &str, evidence: &[&str]) -> Result<CandidateResult, String> {
        if result.trim().is_empty() {
            return Err("Subagent result is required".into());
        }
        self.result = Some(result.into());
        self.evidence = evidence.iter().map(|value| (*value).to_owned()).collect();
        Ok(CandidateResult {
            child_run_id: self.id,
            result: result.into(),
            evidence: self.evidence,
            parent_verified: false,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CandidateResult {
    pub child_run_id: String,
    pub result: String,
    pub evidence: Vec<String>,
    pub parent_verified: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParentReview {
    Rejected,
    AcceptedForHarnessVerification,
    AcceptedAndVerified,
}

pub fn review_candidate(
    _candidate: &CandidateResult,
    main_agent_accepts: bool,
    harness_required: bool,
) -> ParentReview {
    if !main_agent_accepts {
        ParentReview::Rejected
    } else if harness_required {
        ParentReview::AcceptedForHarnessVerification
    } else {
        ParentReview::AcceptedAndVerified
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WorktreeStatus {
    Active,
    Preserved,
    Integrated,
    Removed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ManagedWorktree {
    pub id: String,
    pub task_id: String,
    pub base_ref: String,
    pub branch: String,
    pub path: String,
    pub status: WorktreeStatus,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum IntegrationChoice {
    Merge,
    Rebase,
    CherryPick,
    KeepForReview,
    Remove,
}

#[derive(Default)]
pub struct SafeWorktreeManager {
    worktrees: BTreeMap<String, ManagedWorktree>,
}

impl SafeWorktreeManager {
    pub fn create_authorized(
        &mut self,
        task_id: &str,
        base_ref: &str,
        branch: &str,
        path: &str,
    ) -> Result<ManagedWorktree, String> {
        if [task_id, base_ref, branch, path]
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return Err(
                "authorized Worktree requires task, exact base ref, branch, and path".into(),
            );
        }
        if self
            .worktrees
            .values()
            .any(|worktree| worktree.branch == branch || worktree.path == path)
        {
            return Err("Worktree branch or path already managed".into());
        }
        let worktree = ManagedWorktree {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            base_ref: base_ref.into(),
            branch: branch.into(),
            path: path.into(),
            status: WorktreeStatus::Active,
        };
        self.worktrees.insert(worktree.id.clone(), worktree.clone());
        Ok(worktree)
    }
    pub fn get(&self, id: &str) -> Option<&ManagedWorktree> {
        self.worktrees.get(id)
    }
    pub fn integrate(
        &mut self,
        id: &str,
        choice: IntegrationChoice,
        explicitly_authorized: bool,
    ) -> Result<(), String> {
        if !explicitly_authorized {
            return Err("Worktree integration requires explicit authority".into());
        }
        let worktree = self
            .worktrees
            .get_mut(id)
            .ok_or_else(|| "Worktree missing".to_owned())?;
        worktree.status = match choice {
            IntegrationChoice::KeepForReview => WorktreeStatus::Preserved,
            IntegrationChoice::Remove => WorktreeStatus::Removed,
            _ => WorktreeStatus::Integrated,
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn task_graph_and_checkpoint_restore_the_same_ready_set_without_secrets() {
        let mut graph = TaskGraph::new("task-a");
        graph.add_stage(Stage::new("map", &[], "main")).unwrap();
        graph
            .add_stage(Stage::new("edit", &["map"], "main"))
            .unwrap();
        graph
            .add_stage(Stage::new("verify", &["edit"], "main"))
            .unwrap();
        assert_eq!(graph.ready(), vec!["map"]);
        graph.complete("map", &["evidence:map"]).unwrap();
        assert_eq!(graph.ready(), vec!["edit"]);
        assert!(graph
            .add_stage(Stage::new("cycle", &["missing"], "main"))
            .is_err());

        let checkpoint = CheckpointPackage::build(
            "ship feature",
            &["do not touch user files"],
            &graph,
            BTreeMap::from([("workspace".to_owned(), "workspace:game".to_owned())]),
            &["secret-value".to_owned()],
        )
        .unwrap();
        let encoded = serde_json::to_string(&checkpoint).unwrap();
        assert!(!encoded.contains("secret-value"));
        let restored: CheckpointPackage = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.graph.ready(), graph.ready());
    }

    #[test]
    fn jobs_and_write_leases_are_bounded_attributed_and_crash_reconciled() {
        let root = std::env::temp_dir().join(format!("picode-orchestration-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let mut leases = WriteLeaseManager::default();
        leases
            .acquire("run-a", &root.join("workspace"), 10)
            .unwrap();
        assert!(leases
            .acquire("run-b", &root.join("workspace").join("."), 11)
            .is_err());
        leases.reconcile(|run_id| run_id != "run-a");
        leases
            .acquire("run-b", &root.join("workspace"), 12)
            .unwrap();

        let mut jobs = BackgroundJobManager::new(12);
        let job = jobs.start("task-a", "run-b", 4_200, 10).unwrap();
        jobs.append_output(&job.id, b"abcdefghijklmnopqrstuvwxyz")
            .unwrap();
        assert_eq!(jobs.get(&job.id).unwrap().live_tail, b"opqrstuvwxyz");
        assert_eq!(jobs.get(&job.id).unwrap().full_output_hash.len(), 64);
        jobs.reconcile_after_restart(|_| false, 20);
        assert_eq!(jobs.get(&job.id).unwrap().status, JobStatus::Terminated);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delegation_filters_before_model_ranking_and_records_every_decision() {
        let envelope = DelegationEnvelope {
            goal: "find all references".to_owned(),
            scope: vec!["src/".to_owned()],
            method: "text search".to_owned(),
            tools: BTreeSet::from(["search".to_owned(), "read".to_owned()]),
            permissions: BTreeSet::from(["workspace.read".to_owned()]),
            context: vec!["symbol=Player".to_owned()],
            stop_conditions: vec!["all matches listed".to_owned()],
            expected_result: "path and line list".to_owned(),
        };
        let work = DelegatedWork::read_only_search("repository-search", envelope.clone());
        assert_eq!(delegation_eligibility(&work), Eligibility::Eligible);
        let mut risky = work.clone();
        risky.requires_write = true;
        assert_eq!(
            delegation_eligibility(&risky),
            Eligibility::Rejected("writes are not eligible".to_owned())
        );

        let policy = SubagentModelPolicy {
            candidates: vec![
                ModelCandidate::new("cheap", 8, 10, 2, true),
                ModelCandidate::new("capable", 10, 7, 8, true),
            ],
            fallback: ModelFallback::Ask,
        };
        let evals = RoutingEvaluations::qualified("repository-search", &["capable", "cheap"]);
        let decision = route_delegation(&work, &policy, &evals).unwrap();
        assert_eq!(decision.model_id, "capable");
        assert!(decision.reason.contains("capability"));
        assert_eq!(decision.envelope, envelope);

        let child = SubagentRun::spawn("main-run", decision, false).unwrap();
        assert!(SubagentRun::spawn(&child.id, child.decision.clone(), true).is_err());
        let candidate = child
            .finish("found 12 references", &["artifact:search"])
            .unwrap();
        assert!(!candidate.parent_verified);
        assert_eq!(
            review_candidate(&candidate, true, true),
            ParentReview::AcceptedForHarnessVerification
        );
    }

    #[test]
    fn safe_worktree_never_merges_or_deletes_without_explicit_integration() {
        let mut manager = SafeWorktreeManager::default();
        let worktree = manager
            .create_authorized("task-a", "refs/heads/main", "picode/task-a", "D:/repo-wt")
            .unwrap();
        assert_eq!(worktree.status, WorktreeStatus::Active);
        assert!(manager
            .integrate(&worktree.id, IntegrationChoice::Merge, false)
            .is_err());
        manager
            .integrate(&worktree.id, IntegrationChoice::KeepForReview, true)
            .unwrap();
        assert_eq!(
            manager.get(&worktree.id).unwrap().status,
            WorktreeStatus::Preserved
        );
    }
}
