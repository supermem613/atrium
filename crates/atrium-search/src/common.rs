use std::path::Path;
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
