use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Provider API keys copied once from the Mac. An empty field was not set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderKeys {
    #[serde(default)]
    pub xai: String,
    #[serde(default)]
    pub anthropic: String,
    #[serde(default)]
    pub minimax: String,
}

impl ProviderKeys {
    pub fn any(&self) -> bool {
        [&self.xai, &self.anthropic, &self.minimax].iter().any(|value| !value.trim().is_empty())
    }

    pub fn trimmed(&self) -> Self {
        Self {
            xai: self.xai.trim().to_string(),
            anthropic: self.anthropic.trim().to_string(),
            minimax: self.minimax.trim().to_string(),
        }
    }
}

pub struct KeyFile {
    pub path: std::path::PathBuf,
}

impl KeyFile {
    pub fn in_dir(dir: &Path) -> Self {
        Self { path: dir.join("provider-keys.json") }
    }

    pub fn save(&self, keys: &ProviderKeys) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&keys.trimmed())?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn load(&self) -> Result<ProviderKeys> {
        if !self.path.is_file() {
            return Ok(ProviderKeys::default());
        }
        let raw = fs::read_to_string(&self.path)?;
        if raw.trim().is_empty() {
            return Ok(ProviderKeys::default());
        }
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn remove(&self) -> Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}

pub fn provider_keys_from_env(file: &ProviderKeys) -> ProviderKeys {
    ProviderKeys {
        xai: pick(&file.xai, "XAI_API_KEY"),
        anthropic: pick(&file.anthropic, "ANTHROPIC_API_KEY"),
        minimax: pick(&file.minimax, "MINIMAX_API_KEY"),
    }
}

fn pick(file_value: &str, env_name: &str) -> String {
    let trimmed = file_value.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    std::env::var(env_name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copied_keys_stay_out_of_the_project_folder() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("billing");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("README.md"), "notes").unwrap();
        let file = KeyFile::in_dir(&root.path().join("data"));
        file.save(&ProviderKeys {
            xai: "xai-secret".into(),
            anthropic: "  ".into(),
            minimax: "mini-secret".into(),
        })
        .unwrap();
        let loaded = file.load().unwrap();
        assert_eq!(loaded.xai, "xai-secret");
        assert!(loaded.anthropic.is_empty());
        assert!(!fs::read_to_string(project.join("README.md")).unwrap().contains("xai-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file.path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        file.remove().unwrap();
        assert!(!file.load().unwrap().any());
    }
}
