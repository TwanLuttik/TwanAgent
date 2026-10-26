use std::path::{Component, Path};

use crate::error::{Error, Result};

/// Join a remote project root and a model-supplied relative path. Absolute paths and `..` are rejected.
pub fn remote_join(root: &str, rel: &str) -> Result<String> {
    let root = super::config::validate_remote_path(root)?;
    if rel.contains("..") || rel.trim().starts_with('/') || rel.trim().starts_with('\\') {
        return Err(Error::Other("path is outside the workspace".into()));
    }
    let rel = rel.trim().trim_matches('/');
    if rel.is_empty() || rel == "." {
        return Ok(root);
    }
    if rel.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(Error::Other("path must be relative to the workspace".into()));
    }
    let mut parts: Vec<String> = root
        .split('/')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => {
                let part = part.to_string_lossy().into_owned();
                if part.contains('/') || part.contains('\\') {
                    return Err(Error::Other("invalid path".into()));
                }
                parts.push(part);
            }
            Component::ParentDir => {
                if parts.len() <= 1 {
                    return Err(Error::Other("path is outside the workspace".into()));
                }
                parts.pop();
            }
            _ => {
                return Err(Error::Other("path must be relative to the workspace".into()));
            }
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// Read a remote file by running `cat` on the checked path. The command itself comes from the SSH pool.
pub fn remote_read_command(root: &str, rel: &str) -> Result<String> {
    let remote = remote_join(root, rel)?;
    Ok(format!("cat {}", super::ssh::shell_single_quote(&remote)))
}

pub fn remote_write_script(root: &str, rel: &str) -> Result<String> {
    let remote = remote_join(root, rel)?;
    let quoted = super::ssh::shell_single_quote(&remote);
    // The braces keep the pipe attached to cat. Without them, mkdir eats the bytes and the file is empty.
    Ok(format!("{{ mkdir -p \"$(dirname {quoted})\" && cat > {quoted}; }}"))
}

/// Pipe base64-decoded file bytes into `script`. The command string never contains the raw contents.
/// Base64 is A-Za-z0-9+/=, so a single-quoted payload cannot break out or expand.
pub fn remote_write_shell(contents: &str, script: &str) -> String {
    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        contents.as_bytes(),
    );
    format!("printf '%s' '{encoded}' | base64 -d | {script}")
}

/// Content search on the server. The pattern is data, not a shell snippet.
/// Heavy trees are pruned. Output is `path:line:text`, capped at 100 lines.
pub fn remote_grep_command(root: &str, pattern: &str, rel: &str, glob: &str) -> Result<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("pattern is empty".into()));
    }
    if pattern.contains('\0') || glob.contains('\0') {
        return Err(Error::Other("invalid pattern".into()));
    }
    let remote = remote_join(root, rel)?;
    let quoted = super::ssh::shell_single_quote(&remote);
    let root_q = super::ssh::shell_single_quote(root);
    let pattern_q = super::ssh::shell_single_quote(pattern);
    let glob_q = super::ssh::shell_single_quote(glob.trim());
    let prune = heavy_prune();
    let script = remote_search_script(GREP_PROGRAM);
    Ok(format!(
        "if [ ! -e {quoted} ]; then echo 'path was not found' >&2; exit 1; fi; \
         find {quoted} \\( {prune} \\) -prune -o -type f -print0 -o -true | {script} {root_q} {quoted} {pattern_q} {glob_q}"
    ))
}

/// Path search on the server. `*` stays in one segment. `**` crosses folders.
pub fn remote_glob_command(root: &str, pattern: &str, rel: &str) -> Result<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("pattern is empty".into()));
    }
    if pattern.contains('\0') {
        return Err(Error::Other("invalid pattern".into()));
    }
    let remote = remote_join(root, rel)?;
    let quoted = super::ssh::shell_single_quote(&remote);
    let pattern_q = super::ssh::shell_single_quote(pattern);
    let prune = heavy_prune();
    let script = remote_search_script(GLOB_PROGRAM);
    Ok(format!(
        "if [ ! -d {quoted} ]; then echo 'path is not a folder' >&2; exit 1; fi; \
         find {quoted} \\( {prune} \\) -prune -o -print | {script} {quoted} {pattern_q}"
    ))
}

/// Base64, same reason as the project listing: an exec channel closes stdin, so a heredoc never runs.
fn remote_search_script(program: &str) -> String {
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, program.as_bytes());
    // The decoded program is python's -c argument. Find's output stays on stdin.
    // A pipe into python would swallow that output, because the decoder would own stdin.
    format!(
        "python3 -c \"$(printf '%s' {} | base64 -d)\"",
        super::ssh::shell_single_quote(&encoded)
    )
}

const GREP_PROGRAM: &str = r#"import os, sys
root = os.path.realpath(sys.argv[1])
start = os.path.realpath(sys.argv[2])
pat = sys.argv[3].lower()
glob = sys.argv[4]
limit = 100
hits = []
files = sys.stdin.buffer.read().split(b"\0")

def match(pat, text):
    # Characters, not bytes. A byte-wise `*` misses `*.ts` on a name like café.ts.
    pat = list(pat)
    text = list(text)
    pi = ti = 0
    star = None
    while ti < len(text):
        if pi < len(pat) and (pat[pi] == "?" or pat[pi].lower() == text[ti].lower()):
            pi += 1
            ti += 1
            continue
        if pi < len(pat) and pat[pi] == "*":
            star = (pi, ti)
            pi += 1
            continue
        if star is not None:
            pi = star[0] + 1
            ti = star[1] + 1
            star = (star[0], ti)
            continue
        return False
    while pi < len(pat) and pat[pi] == "*":
        pi += 1
    return pi == len(pat)

def glob_ok(pattern, path):
    parts = [part for part in pattern.split("/") if part]
    segs = [part for part in path.split("/") if part]
    def walk(left, right):
        if not left:
            return not right
        if left[0] == "**":
            if walk(left[1:], right):
                return True
            return bool(right) and walk(left, right[1:])
        if not right:
            return False
        return match(left[0], right[0]) and walk(left[1:], right[1:])
    return walk(parts, segs)

for raw in files:
    if not raw or len(hits) >= limit:
        continue
    path = os.path.realpath(raw.decode("utf-8", "replace"))
    if path == root:
        continue
    rel = os.path.relpath(path, root) if path.startswith(root + os.sep) or path == root else os.path.basename(path)
    name = rel.rsplit("/", 1)[-1]
    name_ok = "/" not in glob and "/" in rel and glob_ok(glob, name)
    if glob and not glob_ok(glob, rel) and not name_ok:
        continue
    try:
        data = open(path, "rb").read(400001)
    except OSError:
        continue
    if len(data) > 400000 or b"\0" in data:
        continue
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        continue
    for number, line in enumerate(text.splitlines(), 1):
        if pat in line.lower():
            hits.append("%s:%d:%s" % (rel, number, line.strip()[:240]))
            if len(hits) >= limit:
                break

if not hits:
    scope = "the workspace" if start == root else os.path.relpath(start, root)
    note = "Searched every text file. .ts, .tsx, and other source files are included." if not glob else "File glob: %s." % glob
    sys.stdout.write("No matches for \"%s\" in %s. %s This is a case-insensitive substring, not a regular expression. Nothing was skipped because of its extension.\n" % (sys.argv[3], scope, note))
else:
    sys.stdout.write("\n".join(hits))
    if len(hits) >= limit:
        sys.stdout.write("\n…results truncated")
    sys.stdout.write("\n")
"#;

const GLOB_PROGRAM: &str = r#"import os, sys
root = os.path.realpath(sys.argv[1])
pat = sys.argv[2]
limit = 200
hits = []

def match(pat, text):
    # Characters, not bytes. A byte-wise `*` misses `*.ts` on a name like café.ts.
    pat = list(pat)
    text = list(text)
    pi = ti = 0
    star = None
    while ti < len(text):
        if pi < len(pat) and (pat[pi] == "?" or pat[pi].lower() == text[ti].lower()):
            pi += 1
            ti += 1
            continue
        if pi < len(pat) and pat[pi] == "*":
            star = (pi, ti)
            pi += 1
            continue
        if star is not None:
            pi = star[0] + 1
            ti = star[1] + 1
            star = (star[0], ti)
            continue
        return False
    while pi < len(pat) and pat[pi] == "*":
        pi += 1
    return pi == len(pat)

def glob_ok(pattern, path):
    parts = [part for part in pattern.split("/") if part]
    segs = [part for part in path.split("/") if part]
    def walk(left, right):
        if not left:
            return not right
        if left[0] == "**":
            if walk(left[1:], right):
                return True
            return bool(right) and walk(left, right[1:])
        if not right:
            return False
        return match(left[0], right[0]) and walk(left[1:], right[1:])
    return walk(parts, segs)

for line in sys.stdin:
    path = os.path.realpath(line.strip())
    if not path or path == root or len(hits) >= limit:
        continue
    rel = os.path.relpath(path, root) if path.startswith(root + os.sep) else path
    name = rel.rsplit("/", 1)[-1]
    if glob_ok(pat, rel) or ("/" not in pat and "/" in rel and glob_ok(pat, name)):
        hits.append(rel)

hits.sort()
if not hits:
    sys.stdout.write("No files.\n")
else:
    sys.stdout.write("\n".join(hits))
    if len(hits) >= limit:
        sys.stdout.write("\n…results truncated")
    sys.stdout.write("\n")
"#;

fn heavy_prune() -> String {
    HEAVY_DIR_NAMES
        .iter()
        .map(|name| format!("-name {}", super::ssh::shell_single_quote(name)))
        .collect::<Vec<_>>()
        .join(" -o ")
}

pub fn remote_list_command(root: &str, rel: &str) -> Result<String> {
    let remote = remote_join(root, rel)?;
    let quoted = super::ssh::shell_single_quote(&remote);
    // A new project folder, or a folder the tree guessed, is empty rather than an ls error.
    Ok(format!("if [ -d {quoted} ]; then ls -1ap {quoted}; fi"))
}

/// Folders under `$HOME/projects` and `$HOME/twanagent/projects`.
/// A project created on another Mac lives there even when this Mac never saved it.
/// Output is one absolute path per line. Dot folders and the projects roots themselves are skipped.
///
/// The script is base64, not a heredoc. An exec channel does not keep stdin open the way a
/// terminal does, so `python3 - <<'PY'` exits before the script arrives and the server
/// reports a failed command with no output. That showed up on Tailscale, where the hop is slower.
pub fn remote_projects_command() -> String {
    const PROGRAM: &str = r#"import os
home = os.path.expanduser("~")
roots = [
    os.path.join(home, "projects"),
    os.path.join(home, "twanagent", "projects"),
    home,
]
skip = {
    "projects", "twanagent", "bin", "Applications", "Desktop", "Documents", "Downloads",
    "Library", "Movies", "Music", "Pictures", "Public", "snap",
}
seen = []
for root in roots:
    if not os.path.isdir(root):
        continue
    home_root = os.path.realpath(root) == os.path.realpath(home)
    try:
        names = os.listdir(root)
    except OSError:
        continue
    for name in names:
        if not name or name.startswith(".") or name in (".", ".."):
            continue
        if home_root and name in skip:
            continue
        path = os.path.join(root, name)
        if os.path.isdir(path) and not os.path.islink(path) and path not in seen:
            seen.append(path)
for path in seen:
    print(path)
"#;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, PROGRAM.as_bytes());
    format!("printf %s {} | base64 -d | python3 -", super::ssh::shell_single_quote(&encoded))
}

/// One absolute directory per line. Anything that is not an absolute path is dropped.
pub fn parse_remote_projects(text: &str) -> Vec<String> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let path = line.trim();
        if path.len() < 2 || !path.starts_with('/') || path.contains('\0') || path.contains("..") {
            continue;
        }
        if rows.iter().any(|row: &String| row == path) {
            continue;
        }
        rows.push(path.to_string());
    }
    rows.sort();
    rows
}

/// One remote exec that lists every file and folder, skipping heavy build trees.
/// Output is `kind<TAB>path` lines, directories first in each folder is not required.
pub fn remote_tree_command(root: &str) -> Result<String> {
    let remote = remote_join(root, "")?;
    let quoted = super::ssh::shell_single_quote(&remote);
    let prune = heavy_prune();
    Ok(format!(
        "if [ -d {quoted} ]; then find {quoted} \\( {prune} \\) -prune -o -print | while IFS= read -r item; do \
         if [ \"$item\" = {quoted} ]; then continue; fi; \
         if [ -d \"$item\" ]; then printf 'd\\t%s\\n' \"${{item#{quoted}/}}\"; \
         elif [ -f \"$item\" ]; then printf 'f\\t%s\\n' \"${{item#{quoted}/}}\"; fi; done; fi"
    ))
}

pub fn remote_rename_command(root: &str, from: &str, name: &str) -> Result<(String, String)> {
    let from_rel = clean_rel(from)?;
    if from_rel.is_empty() {
        return Err(Error::Other("cannot rename the workspace root".into()));
    }
    let next = entry_name(name)?;
    let parent = parent_rel(&from_rel);
    let to_rel = join_rel(&parent, &next);
    remote_move_command(root, &from_rel, &to_rel)
}

pub fn remote_move_command(root: &str, from: &str, to: &str) -> Result<(String, String)> {
    let from_rel = clean_rel(from)?;
    let to_rel = clean_rel(to)?;
    if from_rel.is_empty() {
        return Err(Error::Other("cannot move the workspace root".into()));
    }
    if to_rel.is_empty() {
        return Err(Error::Other("invalid destination".into()));
    }
    if from_rel == to_rel {
        return Ok((String::new(), to_rel));
    }
    if is_within(&to_rel, &from_rel) {
        return Err(Error::Other("cannot move a folder into itself".into()));
    }
    let _ = entry_name(&to_rel)?;
    let src = remote_join(root, &from_rel)?;
    let dest = remote_join(root, &to_rel)?;
    let src_q = super::ssh::shell_single_quote(&src);
    let dest_q = super::ssh::shell_single_quote(&dest);
    let parent_q = super::ssh::shell_single_quote(&parent_of_remote(&dest));
    Ok((
        format!(
            "if [ ! -e {src_q} ]; then echo 'not found' >&2; exit 1; fi; \
             if [ -e {dest_q} ]; then echo 'something with that name already exists' >&2; exit 1; fi; \
             mkdir -p {parent_q} && mv {src_q} {dest_q}"
        ),
        to_rel,
    ))
}

pub fn remote_delete_command(root: &str, rels: &[String]) -> Result<String> {
    let tops = top_level_rels(rels)?;
    if tops.is_empty() {
        return Err(Error::Other("nothing to delete".into()));
    }
    let mut checks = Vec::new();
    let mut removes = Vec::new();
    for rel in tops {
        let remote = remote_join(root, &rel)?;
        let quoted = super::ssh::shell_single_quote(&remote);
        checks.push(format!(
            "if [ ! -e {quoted} ]; then echo 'not found: {rel}' >&2; exit 1; fi"
        ));
        removes.push(format!("rm -rf {quoted}"));
    }
    Ok(format!("{} && {}", checks.join(" && "), removes.join(" && ")))
}

pub fn remote_mkdir_command(root: &str, parent: &str, name: &str) -> Result<(String, String)> {
    let next = entry_name(name)?;
    let rel = join_rel(&clean_rel(parent).unwrap_or_default(), &next);
    let remote = remote_join(root, &rel)?;
    let quoted = super::ssh::shell_single_quote(&remote);
    Ok((
        format!(
            "if [ -e {quoted} ]; then echo 'something with that name already exists' >&2; exit 1; fi; mkdir -p {quoted}"
        ),
        rel,
    ))
}

/// `kind` is `d` or `f`. Paths are workspace-relative with forward slashes.
pub fn parse_remote_tree(text: &str) -> Vec<(String, bool)> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let Some((kind, path)) = line.split_once('\t') else {
            continue;
        };
        let path = path.trim().trim_matches('/');
        if path.is_empty() || path.contains('\0') || path.split('/').any(|part| HEAVY_DIR_NAMES.contains(&part)) {
            continue;
        }
        let dir = kind == "d";
        if kind != "d" && kind != "f" {
            continue;
        }
        rows.push((path.to_string(), dir));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows.dedup();
    rows
}

const HEAVY_DIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    "__pycache__",
    ".next",
    ".turbo",
];

fn clean_rel(rel: &str) -> Result<String> {
    let rel = rel.trim().trim_matches('/');
    if rel.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    Ok(rel.to_string())
}

fn entry_name(name: &str) -> Result<String> {
    let name = name.trim().trim_matches('/');
    let base = Path::new(name)
        .file_name()
        .map(|part| part.to_string_lossy().into_owned())
        .filter(|part| !part.is_empty() && part != "." && part != "..")
        .ok_or_else(|| Error::Other("invalid name".into()))?;
    if base.contains('/') || base.contains('\\') || base.contains('\0') {
        return Err(Error::Other("invalid name".into()));
    }
    Ok(base)
}

fn parent_rel(rel: &str) -> String {
    match rel.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    }
}

fn join_rel(dir: &str, name: &str) -> String {
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn is_within(path: &str, dir: &str) -> bool {
    let path = path.trim_matches('/');
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        return true;
    }
    path == dir || path.starts_with(&format!("{dir}/"))
}

fn parent_of_remote(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((parent, _)) if !parent.is_empty() => parent.to_string(),
        _ => "/".into(),
    }
}

fn top_level_rels(rels: &[String]) -> Result<Vec<String>> {
    let mut paths: Vec<String> = Vec::new();
    for rel in rels {
        let clean = clean_rel(rel)?;
        if clean.is_empty() {
            continue;
        }
        if !paths.contains(&clean) {
            paths.push(clean);
        }
    }
    paths.sort();
    Ok(paths
        .iter()
        .filter(|rel| !paths.iter().any(|other| *other != **rel && is_within(rel, other)))
        .cloned()
        .collect())
}

pub fn parse_remote_list(text: &str, rel: &str) -> Vec<(String, bool)> {
    let prefix = rel.trim_matches('/');
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "." && *line != "./" && *line != ".." && *line != "../")
        .map(|line| {
            let dir = line.ends_with('/');
            let name = line.trim_end_matches('/').to_string();
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            (path, dir)
        })
        .filter(|(path, _)| !path.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_inside_the_remote_project_and_rejects_escapes() {
        assert_eq!(
            remote_join("/srv/billing", "src/main.rs").unwrap(),
            "/srv/billing/src/main.rs"
        );
        assert_eq!(remote_join("/srv/billing", ".").unwrap(), "/srv/billing");
        assert!(remote_join("/srv/billing", "../etc/passwd").is_err());
        assert!(remote_join("/srv/billing", "/etc/passwd").is_err());
        assert!(remote_join("/srv/billing", "src/../../etc").is_err());
    }

    #[test]
    fn remote_search_commands_quote_the_pattern_and_reject_escapes() {
        let grep = remote_grep_command("/srv/billing", "answer", "src", "*.rs").unwrap();
        assert!(grep.contains("find '/srv/billing/src'"));
        assert!(grep.contains("-name 'node_modules'"));
        assert!(grep.contains("'answer'"));
        assert!(grep.contains("'*.rs'"));
        assert!(grep.contains("python3 -c") && grep.contains("'/srv/billing' '/srv/billing/src'"));
        assert!(grep.contains("python3 -c \"$(printf '%s'"));
        assert!(!grep.contains("pattern is empty"));
        assert!(remote_grep_command("/srv/billing", "", "", "").is_err());
        assert!(remote_grep_command("/srv/billing", "x", "../etc", "").is_err());
        let glob = remote_glob_command("/srv/billing", "**/*.ts", "").unwrap();
        assert!(glob.contains("find '/srv/billing'"));
        assert!(glob.contains("'**/*.ts'"));
        assert!(remote_glob_command("/srv/billing", "", "src").is_err());
        assert!(remote_glob_command("/srv/billing", "*.ts", "/etc").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn remote_search_scripts_find_files_and_skip_dependencies() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src/app.ts"), "export const answer = 42;\n").unwrap();
        std::fs::write(root.join("node_modules/pkg/skip.ts"), "export const answer = 1;\n").unwrap();
        let root_s = root.to_string_lossy().replace('\\', "/");
        let ran = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_grep_command(&root_s, "answer", "", "*.ts").unwrap())
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&ran.stdout);
        assert!(ran.status.success(), "{}", String::from_utf8_lossy(&ran.stderr));
        assert!(text.contains("src/app.ts:1:"), "{text}");
        assert!(!text.contains("node_modules"));
        std::fs::write(root.join("src/café.ts"), "export const answer = 7;\n").unwrap();
        let unicode = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_grep_command(&root_s, "answer", "", "*.ts").unwrap())
            .output()
            .unwrap();
        let unicode_text = String::from_utf8_lossy(&unicode.stdout);
        assert!(unicode.status.success(), "{}", String::from_utf8_lossy(&unicode.stderr));
        assert!(unicode_text.contains("src/café.ts:"), "{unicode_text}");
        let missed = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_grep_command(&root_s, "missing-symbol", "src", "*.ts").unwrap())
            .output()
            .unwrap();
        let missed_text = String::from_utf8_lossy(&missed.stdout);
        assert!(missed.status.success(), "{}", String::from_utf8_lossy(&missed.stderr));
        assert!(missed_text.contains("No matches for \"missing-symbol\" in src."), "{missed_text}");
        assert!(missed_text.contains("File glob: *.ts."), "{missed_text}");
        assert!(missed_text.contains("not a regular expression"), "{missed_text}");
        let listed = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_glob_command(&root_s, "**/*.ts", "").unwrap())
            .output()
            .unwrap();
        let paths = String::from_utf8_lossy(&listed.stdout);
        assert!(listed.status.success(), "{}", String::from_utf8_lossy(&listed.stderr));
        assert!(paths.contains("src/app.ts"), "{paths}");
        assert!(!paths.contains("node_modules"));
    }

    #[test]
    fn remote_file_commands_quote_the_checked_path() {
        assert_eq!(
            remote_read_command("/srv/billing", "src/a.rs").unwrap(),
            "cat '/srv/billing/src/a.rs'"
        );
        let list = remote_list_command("/home/me/testX2", "src-tauri").unwrap();
        assert!(list.contains("if [ -d '/home/me/testX2/src-tauri' ]"));
        assert!(list.contains("ls -1ap"));
        let write = remote_write_script("/home/me/testX2", "test.txt").unwrap();
        assert!(write.starts_with("{ mkdir -p"));
        assert!(write.contains("cat > '/home/me/testX2/test.txt'"));
        assert!(remote_read_command("/srv/billing", "../etc/passwd").is_err());
        let rows = parse_remote_list("src/\nREADME.md\n./\n../\n", "");
        assert_eq!(rows, vec![("src".into(), true), ("README.md".into(), false)]);
    }

    #[test]
    fn remote_write_shell_encodes_contents_so_the_command_has_no_raw_payload() {
        let script = remote_write_script("/srv/billing", "src/a.rs").unwrap();
        let payload = "hello $(touch /tmp/pwn) `whoami` 'quotes' \"double\"\nline two\n";
        let command = remote_write_shell(payload, &script);
        assert!(!command.contains("$(touch /tmp/pwn)"));
        assert!(!command.contains("`whoami`"));
        assert!(!command.contains("line two"));
        assert!(command.starts_with("printf '%s' '"));
        assert!(command.contains(" | base64 -d | "));
        assert!(command.ends_with(&script));
        let encoded = command
            .strip_prefix("printf '%s' '")
            .and_then(|rest| rest.split_once("' | base64 -d | "))
            .map(|(b64, _)| b64)
            .expect("base64 payload");
        assert!(encoded.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')));
        let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap();
        assert_eq!(decoded, payload.as_bytes());

        let empty = remote_write_shell("", &script);
        assert!(empty.starts_with("printf '%s' '' | base64 -d | "));
        assert!(empty.ends_with(&script));
    }

    #[test]
    fn remote_projects_keep_absolute_folders_only() {
        let command = remote_projects_command();
        assert!(!command.contains("<<"), "a heredoc never receives its body on an exec channel");
        assert!(command.contains("base64 -d | python3 -"));
        let encoded = command
            .strip_prefix("printf %s '")
            .and_then(|rest| rest.strip_suffix("' | base64 -d | python3 -"))
            .expect("base64 payload");
        let script = String::from_utf8(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap(),
        )
        .unwrap();
        assert!(script.contains("projects"));
        assert!(script.contains("twanagent"));
        let rows = parse_remote_projects(
            "/home/dev/projects/billing\n/home/dev/twanagent/projects/notes\nrelative\n/home/dev/../etc\n\n",
        );
        assert_eq!(
            rows,
            vec![
                "/home/dev/projects/billing".to_string(),
                "/home/dev/twanagent/projects/notes".to_string(),
            ]
        );
        let saved = vec![crate::remote::config::RemoteProject {
            id: "p1".into(),
            machine_id: "m1".into(),
            name: "billing".into(),
            remote_path: "/home/dev/projects/billing".into(),
            mount_path: "/tmp/mounts/p1".into(),
            created_at: "now".into(),
        }];
        let marked = crate::remote::commands::server_projects_from(
            "/home/dev/projects/billing\n/home/dev/projects/notes\n",
            "m1",
            &saved,
        );
        assert!(marked.iter().any(|row| row.remote_path == "/home/dev/projects/notes" && !row.saved));
        assert!(marked.iter().any(|row| row.remote_path == "/home/dev/projects/billing" && row.saved));
    }

    #[test]
    fn remote_tree_skips_heavy_dirs_and_parses_kind_lines() {
        let command = remote_tree_command("/srv/billing").unwrap();
        assert!(command.contains("find '/srv/billing'"));
        assert!(command.contains("-name 'node_modules'"));
        assert!(command.contains("-name '.git'"));
        assert!(command.contains("-prune"));
        let rows = parse_remote_tree("d\tsrc\nf\tsrc/a.rs\nd\tnode_modules\nf\tREADME.md\n?\tbad\n");
        assert_eq!(
            rows,
            vec![
                ("README.md".into(), false),
                ("src".into(), true),
                ("src/a.rs".into(), false),
            ]
        );
    }

    #[test]
    fn remote_mutations_quote_paths_and_reject_escapes() {
        let (rename, renamed) = remote_rename_command("/srv/billing", "src/a.rs", "b.rs").unwrap();
        assert_eq!(renamed, "src/b.rs");
        assert!(rename.contains("mv '/srv/billing/src/a.rs' '/srv/billing/src/b.rs'"));
        assert!(remote_rename_command("/srv/billing", "../etc", "x").is_err());

        let (mkdir, made) = remote_mkdir_command("/srv/billing", "src", "box").unwrap();
        assert_eq!(made, "src/box");
        assert!(mkdir.contains("mkdir -p '/srv/billing/src/box'"));

        let delete = remote_delete_command("/srv/billing", &["src/box".into(), "src/box/a.rs".into()]).unwrap();
        assert!(delete.contains("rm -rf '/srv/billing/src/box'"));
        assert!(!delete.contains("src/box/a.rs"));
        assert!(remote_delete_command("/srv/billing", &["".into()]).is_err());

        let (mv, dest) = remote_move_command("/srv/billing", "src/a.rs", "docs/a.rs").unwrap();
        assert_eq!(dest, "docs/a.rs");
        assert!(mv.contains("mkdir -p '/srv/billing/docs'"));
        assert!(remote_move_command("/srv/billing", "src", "src/nested").is_err());
    }
}
