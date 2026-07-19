use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use ignore::overrides::{Override, OverrideBuilder};
use ignore::WalkBuilder;
use napi::{Error, Result, Status};

pub fn err(context: &str, e: impl std::fmt::Display) -> Error {
  Error::new(Status::GenericFailure, format!("{context}: {e}"))
}

// Cooperative stop control shared by content and file searches. It is checked
// inside the walk loop and the content sink so a search stops between units of
// work rather than being forcibly interrupted mid-read. A `max` reached marks
// the result truncated; a passed deadline marks it timed out. `Some(0)` for the
// timeout is an immediate deadline, i.e. an abort before any work is emitted.
pub struct Control {
  deadline: Option<Instant>,
  max: Option<usize>,
  pub timed_out: bool,
  pub truncated: bool,
}

impl Control {
  pub fn new(start: Instant, timeout_ms: Option<u32>, max: Option<u32>) -> Self {
    Control {
      deadline: timeout_ms.map(|ms| start + std::time::Duration::from_millis(ms as u64)),
      max: max.map(|m| m as usize),
      timed_out: false,
      truncated: false,
    }
  }

  // Returns true when the caller should stop before doing more work. Sets the
  // matching outcome flag as a side effect so the result reports why it stopped.
  pub fn should_stop(&mut self, produced: usize) -> bool {
    if let Some(deadline) = self.deadline {
      if Instant::now() >= deadline {
        self.timed_out = true;
        return true;
      }
    }
    if let Some(max) = self.max {
      if produced >= max {
        self.truncated = true;
        return true;
      }
    }
    false
  }
}

pub fn safe_walk_root(root: &Path, globs_opt: &Option<Vec<String>>) -> PathBuf {
  let Some(_globs) = globs_opt else {
    return root.to_path_buf();
  };

  let mut prefixes: Vec<Vec<String>> = Vec::new();
  if let Some(globs) = globs_opt.as_ref() {
    for glob in globs {
      let Some(prefix) = literal_directory_prefix(glob) else {
        return root.to_path_buf();
      };
      prefixes.push(prefix);
    }
  }

  if prefixes.is_empty() {
    return root.to_path_buf();
  }

  let mut common = prefixes[0].clone();
  for prefix in prefixes.iter().skip(1) {
    let len = common.len().min(prefix.len());
    let mut shared_len = 0;
    while shared_len < len && common[shared_len] == prefix[shared_len] {
      shared_len += 1;
    }
    common.truncate(shared_len);
    if common.is_empty() {
      break;
    }
  }

  if common.is_empty() {
    root.to_path_buf()
  } else {
    let walk_root = root.join(PathBuf::from(common.join("/")));
    if walk_root == root {
      root.to_path_buf()
    } else {
      walk_root
    }
  }
}

fn literal_directory_prefix(glob: &str) -> Option<Vec<String>> {
  if glob.is_empty() || glob.starts_with('/') || glob.contains('\\') || glob.contains('{') || glob.contains('}') || glob.contains('[') || glob.contains(']') {
    return None;
  }
  if Path::new(glob)
    .components()
    .any(|component| matches!(component, Component::Prefix(_) | Component::RootDir | Component::ParentDir))
  {
    return None;
  }

  let mut segments: Vec<String> = Vec::new();
  let mut saw_non_literal = false;
  let mut saw_literal = false;

  for segment in glob.split('/') {
    if segment.is_empty() || segment == "." {
      continue;
    }
    if segment == ".." {
      return None;
    }
    if is_literal_segment(segment) {
      saw_literal = true;
      segments.push(segment.to_string());
    } else {
      saw_non_literal = true;
      break;
    }
  }

  if !saw_literal {
    return None;
  }

  if !saw_non_literal && segments.len() > 1 {
    segments.pop();
  }

  if segments.is_empty() {
    None
  } else {
    Some(segments)
  }
}

fn is_literal_segment(segment: &str) -> bool {
  !segment.contains('*') && !segment.contains('?') && !segment.contains('[') && !segment.contains(']') && !segment.contains('{') && !segment.contains('}')
}

// Include globs act as a whitelist; excludes are added as `!glob` blacklist
// entries. This mirrors ripgrep's `--glob` / `--glob !pat` handling.
pub fn build_overrides(
  root: &Path,
  globs: &Option<Vec<String>>,
  excludes: &Option<Vec<String>>,
) -> Result<Override> {
  let mut builder = OverrideBuilder::new(root);
  for glob in globs.iter().flatten() {
    builder.add(glob).map_err(|e| err("invalid glob", e))?;
  }
  for exclude in excludes.iter().flatten() {
    let pattern = if exclude.starts_with('!') {
      exclude.clone()
    } else {
      format!("!{exclude}")
    };
    builder.add(&pattern).map_err(|e| err("invalid exclude glob", e))?;
  }
  builder.build().map_err(|e| err("failed to build overrides", e))
}

// Mirror ripgrep's default filtering, and `--hidden --no-ignore` when `all`.
pub fn configure_ignore(builder: &mut WalkBuilder, all: bool) {
  if all {
    builder.hidden(false);
    builder.ignore(false);
    builder.git_ignore(false);
    builder.git_global(false);
    builder.git_exclude(false);
    builder.parents(false);
  }
}

pub fn relative_display(base: &Path, path: &Path) -> String {
  path
    .strip_prefix(base)
    .unwrap_or(path)
    .to_string_lossy()
    .into_owned()
}

#[cfg(test)]
mod tests {
  use super::{literal_directory_prefix, safe_walk_root};
  use std::path::Path;

  #[test]
  fn derives_shared_literal_directory_prefix() {
    let root = Path::new("/tmp/root");
    let globs = Some(vec!["test/**/*undo*.test.ts".to_string()]);

    assert_eq!(safe_walk_root(root, &globs), root.join("test"));
    assert_eq!(literal_directory_prefix("test/**/*undo*.test.ts"), Some(vec!["test".to_string()]));
  }

  #[test]
  fn falls_back_for_basename_only_globs() {
    let root = Path::new("/tmp/root");
    let globs = Some(vec!["*.ts".to_string()]);

    assert_eq!(safe_walk_root(root, &globs), root.to_path_buf());
    assert_eq!(literal_directory_prefix("*.ts"), None);
  }

  #[test]
  fn falls_back_for_unsafe_globs() {
    let root = Path::new("/tmp/root");
    let globs = Some(vec!["test/{foo,bar}.ts".to_string()]);

    assert_eq!(safe_walk_root(root, &globs), root.to_path_buf());
    assert_eq!(literal_directory_prefix("test/{foo,bar}.ts"), None);
    assert_eq!(literal_directory_prefix("/outside/**/*.ts"), None);
  }

  #[cfg(windows)]
  #[test]
  fn falls_back_for_windows_drive_prefixed_globs() {
    let root = Path::new(r"C:\requested\root");
    let globs = Some(vec!["C:/outside/**/*.ts".to_string()]);

    assert_eq!(safe_walk_root(root, &globs), root.to_path_buf());
    assert_eq!(literal_directory_prefix("C:/outside/**/*.ts"), None);
  }

  #[test]
  fn falls_back_for_non_common_globs() {
    let root = Path::new("/tmp/root");
    let globs = Some(vec!["src/**/*.ts".to_string(), "test/**/*.ts".to_string()]);

    assert_eq!(safe_walk_root(root, &globs), root.to_path_buf());
  }
}
