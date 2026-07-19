use std::path::PathBuf;
use std::time::Instant;

use ignore::WalkBuilder;
use napi::Result;

use crate::common::{build_overrides, configure_ignore, relative_display, safe_walk_root, Control};
use crate::{NativeFilesSearchOptions, NativeSearchMetrics};

pub struct FilesSearchOutcome {
  pub paths: Vec<String>,
  pub truncated: bool,
  pub timed_out: bool,
  pub metrics: Option<NativeSearchMetrics>,
}

pub fn search(options: &NativeFilesSearchOptions) -> Result<FilesSearchOutcome> {
  let start = Instant::now();
  let base_dir = PathBuf::from(&options.root);
  let root_is_file = options.root_is_file.unwrap_or(false);
  let all = options.all.unwrap_or(false);
  let want_perf = options.perf.unwrap_or(false);

  // For a file root, ripgrep runs with cwd = dirname and `-- <basename>`; the
  // addon receives `root` = that dirname and lists only the named file.
  let walk_root: PathBuf = if root_is_file {
    match &options.root_name {
      Some(name) => base_dir.join(name),
      None => base_dir.clone(),
    }
  } else {
    safe_walk_root(&base_dir, &options.globs)
  };

  let overrides = build_overrides(&base_dir, &options.globs, &options.excludes)?;

  let mut builder = WalkBuilder::new(&walk_root);
  builder.overrides(overrides);
  configure_ignore(&mut builder, all);

  let mut control = Control::new(start, options.timeout_ms, options.max);
  let mut paths: Vec<String> = Vec::new();

  for result in builder.build() {
    if control.should_stop(paths.len()) {
      break;
    }
    let entry = match result {
      Ok(entry) => entry,
      Err(_) => continue,
    };
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    paths.push(relative_display(&base_dir, entry.path()));
    // Re-check after the push so a `max` boundary truncates exactly at max.
    if control.should_stop(paths.len()) {
      break;
    }
  }

  let metrics = if want_perf {
    Some(NativeSearchMetrics {
      searches: paths.len() as u32,
      child_run_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
  } else {
    None
  };

  Ok(FilesSearchOutcome {
    paths,
    truncated: control.truncated,
    timed_out: control.timed_out,
    metrics,
  })
}
