use std::net::{Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Semaphore};

use crate::error::Result;
use crate::process::WindowlessCommand;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanHost {
    pub host: String,
    pub port: u16,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshDefaults {
    pub user: String,
    pub key_path: Option<String>,
}

/// Hosts to probe on the local network. Prefixes wider than /24 are clamped to the /24
/// that contains the interface address so a scan stays under a few hundred addresses.
pub fn hosts_to_scan(addr: Ipv4Addr, prefix: u8, self_addr: Ipv4Addr) -> Vec<Ipv4Addr> {
    let prefix = prefix.clamp(0, 32);
    let scan_prefix = prefix.max(24);
    let ip = u32::from(addr);
    let mask = if scan_prefix == 0 {
        0
    } else {
        u32::MAX << (32 - scan_prefix)
    };
    let network = ip & mask;
    let count = 1u32 << (32 - scan_prefix);
    let mut out = Vec::new();
    for offset in 0..count {
        let next = network.wrapping_add(offset);
        if next == network || next == network.wrapping_add(count.wrapping_sub(1)) {
            continue;
        }
        let host = Ipv4Addr::from(next);
        if host == self_addr || host.is_loopback() || host.is_link_local() || host.is_broadcast() {
            continue;
        }
        out.push(host);
        if out.len() >= 254 {
            break;
        }
    }
    out
}

pub fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "dev".into())
}

pub fn default_key_path() -> Option<String> {
    let home = crate::dev::paths::home_dir()?;
    for name in ["id_ed25519", "id_rsa"] {
        let path = home.join(".ssh").join(name);
        if path.is_file() {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(test)]
fn same_subnet(target: Ipv4Addr, local: Ipv4Addr, prefix: u8) -> bool {
    let bits = prefix.clamp(0, 32);
    if bits == 0 {
        return true;
    }
    let mask = u32::MAX << (32 - bits);
    (u32::from(target) & mask) == (u32::from(local) & mask)
}

pub fn ssh_defaults() -> SshDefaults {
    SshDefaults {
        user: local_user(),
        key_path: default_key_path(),
    }
}

/// Probe saved SSH hosts and the LAN gateway first, then the rest of the /24.
/// Each open port 22 is sent as soon as it answers.
pub async fn scan_ssh_stream(tx: mpsc::UnboundedSender<LanHost>) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    let mut lan = Vec::new();
    for (addr, prefix) in local_networks() {
        for host in hosts_to_scan(addr, prefix, addr) {
            let label = host.to_string();
            if seen.insert(label.clone()) {
                lan.push((label.clone(), label));
            }
        }
    }
    // The local network is the scan. Saved SSH config hosts are a fallback, not the result.
    // OrbStack VMs sit on 192.168.139.0/24, which is not a Mac interface, so the LAN scan misses them.
    probe_many(lan, &tx).await;
    let mut saved = tailscale_hosts();
    saved.extend(orbstack_hosts());
    saved.extend(gateway_hosts());
    saved.extend(known_ssh_hosts());
    saved.retain(|(host, _)| seen.insert(host.to_ascii_lowercase()));
    probe_many(saved, &tx).await;
    Ok(())
}

async fn probe_many(targets: Vec<(String, String)>, tx: &mpsc::UnboundedSender<LanHost>) {
    let gate = std::sync::Arc::new(Semaphore::new(64));
    let mut tasks = tokio::task::JoinSet::new();
    for (host, label) in targets {
        if tx.is_closed() {
            break;
        }
        let gate = gate.clone();
        let tx = tx.clone();
        tasks.spawn(async move {
            let Ok(_permit) = gate.acquire_owned().await else {
                return;
            };
            if let Some(found) = probe_host(&host, &label).await {
                let _ = tx.send(found);
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

async fn probe_host(host: &str, label: &str) -> Option<LanHost> {
    let addr = resolve_ssh(host)?;
    match tokio::time::timeout(Duration::from_millis(700), TcpStream::connect(addr)).await {
        Ok(Ok(stream)) => {
            drop(stream);
            Some(LanHost {
                host: host.to_string(),
                port: 22,
                label: label.to_string(),
            })
        }
        _ => None,
    }
}

fn resolve_ssh(host: &str) -> Option<SocketAddr> {
    let host = host.trim();
    if host.is_empty() || host.contains([' ', '/']) {
        return None;
    }
    // `<machine>@orb` is not an IP. Port 22 on this Mac is the OrbStack proxy.
    if host.ends_with("@orb") {
        return Some(SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, 22)));
    }
    let with_port = if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:22")
    };
    with_port.to_socket_addrs().ok()?.find(|addr| addr.port() == 22)
}

/// Hostnames from `~/.ssh/config`. These are the servers the user already uses,
/// including ones that are not on the current LAN.
pub fn known_ssh_hosts() -> Vec<(String, String)> {
    let Some(home) = crate::dev::paths::home_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Vec::new();
    };
    parse_ssh_config_hosts(&text)
}

pub fn parse_ssh_config_hosts(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut alias = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let key = key.to_ascii_lowercase();
        if key == "host" {
            alias = parts.next().unwrap_or("").to_string();
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                alias = "*".into();
            }
            continue;
        }
        if alias == "*" {
            continue;
        }
        if key == "hostname" {
            let host = parts.next().unwrap_or("").trim().to_string();
            if host.is_empty() || host.contains('*') {
                continue;
            }
            let label = if alias.is_empty() { host.clone() } else { alias.clone() };
            if seen.insert(host.to_ascii_lowercase()) {
                out.push((host, label));
            }
        }
    }
    out
}

/// Running OrbStack Linux machines. `orb list` prints `name status distro version arch`.
/// The address is `<machine>@orb`, which `~/.orbstack/ssh/config` turns into a working SSH login.
/// A bare LAN address for the same VM is not reachable from this Mac.
pub fn orbstack_hosts() -> Vec<(String, String)> {
    let Ok(out) = std::process::Command::new("orb")
        .hide_console_window()
        .arg("list")
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_orb_list(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_orb_list(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(status) = parts.next() else { continue };
        if !status.eq_ignore_ascii_case("running") {
            continue;
        }
        if name.eq_ignore_ascii_case("name") || name.contains('@') || name.contains(' ') {
            continue;
        }
        out.push((format!("{name}@orb"), format!("{name} · OrbStack")));
    }
    out
}

fn tailscale_hosts() -> Vec<(String, String)> {
    let Ok(out) = std::process::Command::new("tailscale")
        .hide_console_window()
        .arg("status")
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_tailscale_status(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_tailscale_status(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(ip) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        if ip.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        if line.to_ascii_lowercase().contains("offline") {
            continue;
        }
        out.push((ip.to_string(), name.to_string()));
    }
    out
}

fn gateway_hosts() -> Vec<(String, String)> {
    #[cfg(unix)]
    {
        unix_gateways()
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

#[cfg(unix)]
fn unix_gateways() -> Vec<(String, String)> {
    let Ok(out) = std::process::Command::new("route")
        .hide_console_window()
        .args(["-n", "get", "default"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("gateway:") else {
            continue;
        };
        let ip = rest.trim();
        if ip.parse::<Ipv4Addr>().is_ok() {
            return vec![(ip.to_string(), "Gateway".into())];
        }
    }
    Vec::new()
}

fn local_networks() -> Vec<(Ipv4Addr, u8)> {
    #[cfg(unix)]
    {
        unix_networks()
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

#[cfg(unix)]
fn unix_networks() -> Vec<(Ipv4Addr, u8)> {
    let mut out = Vec::new();
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 {
            return out;
        }
        let mut cur = head;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_addr.is_null()
                && (*ifa.ifa_addr).sa_family as i32 == libc::AF_INET
                && (ifa.ifa_flags & libc::IFF_UP as u32) != 0
                && (ifa.ifa_flags & libc::IFF_LOOPBACK as u32) == 0
            {
                if let Some(addr) = ipv4_of(ifa.ifa_addr) {
                    if !addr.is_loopback() && !addr.is_link_local() {
                        let prefix = ifa
                            .ifa_netmask
                            .is_null()
                            .then_some(24)
                            .or_else(|| prefix_of(ifa.ifa_netmask))
                            .unwrap_or(24);
                        out.push((addr, prefix));
                    }
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(unix)]
fn ipv4_of(addr: *const libc::sockaddr) -> Option<Ipv4Addr> {
    if addr.is_null() {
        return None;
    }
    unsafe {
        let v4 = &*(addr as *const libc::sockaddr_in);
        Some(Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr)))
    }
}

#[cfg(unix)]
fn prefix_of(mask: *const libc::sockaddr) -> Option<u8> {
    let addr = ipv4_of(mask)?;
    Some(u32::from(addr).count_ones() as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash24_skips_self_network_and_broadcast() {
        let hosts = hosts_to_scan(Ipv4Addr::new(192, 168, 1, 20), 24, Ipv4Addr::new(192, 168, 1, 20));
        assert!(hosts.contains(&Ipv4Addr::new(192, 168, 1, 1)));
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 1, 20)));
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 1, 0)));
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 1, 255)));
        assert!(hosts.len() < 254);
    }

    #[test]
    fn ssh_config_hosts_skip_wildcards_and_keep_the_alias() {
        let rows = parse_ssh_config_hosts(
            "Host houseserver\n  HostName 10.0.0.40\nHost *\n  HostName nope\nHost other\n  Hostname server.local\n",
        );
        assert_eq!(
            rows,
            vec![
                ("10.0.0.40".into(), "houseserver".into()),
                ("server.local".into(), "other".into())
            ]
        );
    }

    #[test]
    fn orb_list_keeps_running_machines() {
        let rows = parse_orb_list(
            "stopped-box            stopped  ubuntu  noble     arm64\n\
devbox                  running  ubuntu  noble     arm64  970.3 MB  192.168.139.2\n\
second-box              running  ubuntu  resolute  arm64\n",
        );
        assert_eq!(
            rows,
            vec![
                ("devbox@orb".into(), "devbox · OrbStack".into()),
                ("second-box@orb".into(), "second-box · OrbStack".into()),
            ]
        );
    }

    #[test]
    fn tailscale_status_keeps_online_peers() {
        let rows = parse_tailscale_status(
            "100.1.1.1   me     user@  macOS -\n100.2.2.2   pve    user@  linux idle\n100.3.3.3   old    user@  linux offline, last seen 1d ago\n",
        );
        assert_eq!(
            rows,
            vec![
                ("100.1.1.1".into(), "me".into()),
                ("100.2.2.2".into(), "pve".into())
            ]
        );
    }

    #[test]
    fn source_stays_on_the_matching_subnet() {
        assert!(same_subnet(
            Ipv4Addr::new(10, 0, 0, 219),
            Ipv4Addr::new(10, 0, 0, 155),
            24
        ));
        assert!(!same_subnet(
            Ipv4Addr::new(10, 0, 0, 219),
            Ipv4Addr::new(100, 66, 149, 94),
            32
        ));
    }

    #[test]
    fn wide_prefix_stays_inside_one_slash24() {
        let hosts = hosts_to_scan(Ipv4Addr::new(10, 1, 2, 5), 16, Ipv4Addr::new(10, 1, 2, 5));
        assert!(hosts.iter().all(|ip| ip.octets()[0] == 10 && ip.octets()[1] == 1 && ip.octets()[2] == 2));
        assert!(hosts.len() <= 254);
    }
}
