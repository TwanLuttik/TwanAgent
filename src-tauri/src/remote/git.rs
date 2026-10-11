use super::ssh::ExecResult;
use crate::error::{Error, Result};

pub fn git_command(args: &[&str]) -> Result<String> {
    if args.is_empty() {
        return Err(Error::Other("git command is empty".into()));
    }
    let mut parts = vec!["git".to_string()];
    for arg in args {
        if arg.contains('\0') || arg.contains('\n') {
            return Err(Error::Other("invalid git argument".into()));
        }
        parts.push(super::ssh::shell_single_quote(arg));
    }
    Ok(parts.join(" "))
}

#[allow(dead_code)]
pub fn remote_git_text(result: &ExecResult) -> String {
    super::exec::format_remote_output(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_command_quotes_each_argument() {
        assert_eq!(
            git_command(&["status", "--porcelain=v1", "src/a file.rs"]).unwrap(),
            "git 'status' '--porcelain=v1' 'src/a file.rs'"
        );
        assert!(git_command(&[]).is_err());
    }
}
