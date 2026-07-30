#![cfg_attr(not(test), allow(dead_code))]

use crate::runtime_registry::MetricAttribution;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessMetric {
    pub process_id: u32,
    pub at: u64,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub uptime_ms: u64,
    pub attribution: MetricAttribution,
}

#[derive(Default)]
pub struct ProcessSampler {
    previous_cpu: BTreeMap<u32, (u64, u64)>,
}

impl ProcessSampler {
    pub fn sample(&mut self, process_id: u32, at: u64) -> Result<ProcessMetric, String> {
        let raw = platform_sample(process_id)?;
        let cpu_percent = self
            .previous_cpu
            .insert(process_id, (at, raw.cpu_100ns))
            .and_then(|(previous_at, previous_cpu)| {
                let wall_100ns = at.saturating_sub(previous_at).saturating_mul(10_000);
                (wall_100ns > 0).then(|| {
                    raw.cpu_100ns.saturating_sub(previous_cpu) as f32 / wall_100ns as f32 * 100.0
                })
            })
            .unwrap_or(0.0)
            .clamp(0.0, 100.0 * available_parallelism() as f32);
        Ok(ProcessMetric {
            process_id,
            at,
            cpu_percent,
            memory_bytes: raw.memory_bytes,
            uptime_ms: raw.uptime_ms,
            attribution: raw.attribution,
        })
    }
}

struct RawProcessMetric {
    cpu_100ns: u64,
    memory_bytes: u64,
    uptime_ms: u64,
    attribution: MetricAttribution,
}

#[cfg(target_os = "windows")]
fn platform_sample(process_id: u32) -> Result<RawProcessMetric, String> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, process_id);
        if handle.is_null() {
            return Err(format!("cannot open process {process_id}"));
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = zeroed();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let memory_ok = K32GetProcessMemoryInfo(
            handle,
            &mut counters,
            size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ) != 0;
        let mut created: FILETIME = zeroed();
        let mut exited: FILETIME = zeroed();
        let mut kernel: FILETIME = zeroed();
        let mut user: FILETIME = zeroed();
        let times_ok =
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        let _ = CloseHandle(handle);
        if !memory_ok || !times_ok {
            return Err(format!("cannot sample process {process_id}"));
        }
        let cpu_100ns = filetime(kernel).saturating_add(filetime(user));
        let now_100ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            / 100;
        const WINDOWS_TO_UNIX_100NS: u128 = 116_444_736_000_000_000;
        let created_unix = (filetime(created) as u128).saturating_sub(WINDOWS_TO_UNIX_100NS);
        Ok(RawProcessMetric {
            cpu_100ns,
            memory_bytes: counters.WorkingSetSize as u64,
            uptime_ms: now_100ns.saturating_sub(created_unix) as u64 / 10_000,
            attribution: MetricAttribution::ProcessOwned,
        })
    }
}

#[cfg(target_os = "windows")]
fn filetime(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

#[cfg(target_os = "linux")]
fn platform_sample(process_id: u32) -> Result<RawProcessMetric, String> {
    let stat = std::fs::read_to_string(format!("/proc/{process_id}/stat"))
        .map_err(|error| format!("cannot read process stat: {error}"))?;
    let fields: Vec<&str> = stat.split_whitespace().collect();
    let user_ticks = fields
        .get(13)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let system_ticks = fields
        .get(14)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let pages = std::fs::read_to_string(format!("/proc/{process_id}/statm"))
        .ok()
        .and_then(|value| value.split_whitespace().nth(1)?.parse::<u64>().ok())
        .unwrap_or(0);
    Ok(RawProcessMetric {
        cpu_100ns: (user_ticks + system_ticks) * 100_000,
        memory_bytes: pages * 4096,
        uptime_ms: 0,
        attribution: MetricAttribution::ProcessOwned,
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn platform_sample(_process_id: u32) -> Result<RawProcessMetric, String> {
    Ok(RawProcessMetric {
        cpu_100ns: 0,
        memory_bytes: 0,
        uptime_ms: 0,
        attribution: MetricAttribution::Unavailable,
    })
}

pub fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub requests: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_micros: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageAttribution {
    ProviderReported,
    Estimated,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageField {
    pub value: Option<u64>,
    pub attribution: UsageAttribution,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedUsage {
    pub requests: UsageField,
    pub input_tokens: UsageField,
    pub output_tokens: UsageField,
    pub cost_micros: UsageField,
}

pub fn normalize_usage(usage: ProviderUsage) -> NormalizedUsage {
    fn field(value: Option<u64>) -> UsageField {
        UsageField {
            value,
            attribution: if value.is_some() {
                UsageAttribution::ProviderReported
            } else {
                UsageAttribution::Unavailable
            },
        }
    }
    NormalizedUsage {
        requests: field(usage.requests),
        input_tokens: field(usage.input_tokens),
        output_tokens: field(usage.output_tokens),
        cost_micros: field(usage.cost_micros),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_metrics_are_owned_bounded_and_nonzero_on_windows() {
        let mut sampler = ProcessSampler::default();
        let first = sampler.sample(std::process::id(), 1_000).unwrap();
        assert_eq!(first.process_id, std::process::id());
        assert_eq!(
            first.attribution,
            crate::runtime_registry::MetricAttribution::ProcessOwned
        );
        #[cfg(target_os = "windows")]
        assert!(first.memory_bytes > 0);
        let second = sampler.sample(std::process::id(), 2_000).unwrap();
        assert!(second.cpu_percent >= 0.0);
        assert!(second.cpu_percent <= 100.0 * available_parallelism() as f32);
    }

    #[test]
    fn provider_usage_keeps_missing_fields_unavailable_and_never_invents_cost() {
        let normalized = normalize_usage(ProviderUsage {
            requests: Some(2),
            input_tokens: Some(100),
            output_tokens: None,
            cost_micros: None,
        });
        assert_eq!(normalized.requests.value, Some(2));
        assert_eq!(
            normalized.requests.attribution,
            UsageAttribution::ProviderReported
        );
        assert_eq!(
            normalized.output_tokens.attribution,
            UsageAttribution::Unavailable
        );
        assert_eq!(normalized.cost_micros.value, None);
    }
}
