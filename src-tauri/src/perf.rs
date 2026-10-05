use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PerfSnapshot {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

pub fn snapshot() -> PerfSnapshot {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = system().lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let proc = sys.process(pid);
    PerfSnapshot {
        cpu_percent: proc.map(|p| p.cpu_usage()).unwrap_or(0.0),
        memory_bytes: proc.map(|p| p.memory()).unwrap_or(0),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_perf_snapshot() -> PerfSnapshot {
    snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_this_process_memory() {
        let first = snapshot();
        let second = snapshot();
        assert!(second.memory_bytes > 0, "native RSS should be visible");
        assert!(first.cpu_percent >= 0.0);
        assert!(second.cpu_percent >= 0.0);
    }
}
