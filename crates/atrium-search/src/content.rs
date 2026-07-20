use std::path::{Path, PathBuf};
use std::time::Instant;

use grep_regex::RegexMatcher;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use ignore::types::TypesBuilder;
use ignore::WalkBuilder;
use napi::Result;

use crate::common::{build_overrides, configure_ignore, err, relative_display, Control};
use crate::{NativeContentMatch, NativeContentSearchOptions, NativeSearchMetrics};

const MAX_FILESIZE: u64 = 2 * 1024 * 1024;

pub struct ContentSearchOutcome {
  pub matches: Vec<NativeContentMatch>,
  pub truncated: bool,
  pub timed_out: bool,
  pub metrics: Option<NativeSearchMetrics>,
}

pub fn search(options: &NativeContentSearchOptions) -> Result<ContentSearchOutcome> {
  let start = Instant::now();
  let root = Path::new(&options.root);
  let regex = options.regex.unwrap_or(false);
  let all = options.all.unwrap_or(false);
  let want_perf = options.perf.unwrap_or(false);
  let root_is_file = options.root_is_file.unwrap_or(false);

  // For a file root, the caller passes root = the parent directory and
  // root_name = the file basename, mirroring ripgrep's `-- <basename>`. Walking
  // that one file keeps a single-file search from spilling into its siblings.
  let walk_root: PathBuf = if root_is_file {
    match &options.root_name {
      Some(name) => root.join(name),
      None => root.to_path_buf(),
    }
  } else {
    root.to_path_buf()
  };

  // `-F` (default) means a literal query. Escaping it into a regex yields the
  // same matches ripgrep produces for fixed strings while reusing one matcher.
  let pattern = if regex {
    options.query.clone()
  } else {
    regex::escape(&options.query)
  };
  let matcher =
    RegexMatcher::new_line_matcher(&pattern).map_err(|e| err("invalid pattern", e))?;

  let overrides = build_overrides(root, &options.globs, &options.excludes)?;

  let mut builder = WalkBuilder::new(&walk_root);
  builder.overrides(overrides);
  builder.max_filesize(Some(MAX_FILESIZE));
  configure_ignore(&mut builder, all);
  configure_types(&mut builder, options)?;

  let mut searcher: Searcher = SearcherBuilder::new()
    .line_number(true)
    .binary_detection(BinaryDetection::quit(0))
    .build();

  let mut control = Control::new(start, options.timeout_ms, options.max);
  let mut matches: Vec<NativeContentMatch> = Vec::new();
  let mut searches: u32 = 0;

  for result in builder.build() {
    if control.should_stop(matches.len()) {
      break;
    }
    let entry = match result {
      Ok(entry) => entry,
      // Mirror ripgrep: skip unreadable entries rather than aborting the walk.
      Err(_) => continue,
    };
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    searches += 1;
    let display_path = relative_display(root, entry.path());
    let mut stop = false;
    let sink = UTF8(|line_number, line| {
      if control.should_stop(matches.len()) {
        stop = true;
        return Ok(false);
      }
      matches.push(NativeContentMatch {
        path: display_path.clone(),
        line: line_number as u32,
        text: line.to_string(),
      });
      // Re-check after the push so a `max` boundary truncates exactly at max
      // rather than one match late.
      if control.should_stop(matches.len()) {
        stop = true;
        return Ok(false);
      }
      Ok(true)
    });
    // Individual file read/search errors are non-fatal in ripgrep's walk.
    let _ = searcher.search_path(&matcher, entry.path(), sink);
    if stop {
      break;
    }
  }

  let metrics = if want_perf {
    Some(NativeSearchMetrics {
      searches,
      child_run_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
  } else {
    None
  };

  Ok(ContentSearchOutcome {
    matches,
    truncated: control.truncated,
    timed_out: control.timed_out,
    metrics,
  })
}

// Translate ripgrep `--type-add`/`--type`/`--type-not` lane args (carried over
// from smartPlan) into the ignore crate's type matcher. Applied only when a
// select or negate is present so a search with only definitions and no
// selection keeps matching every file, as ripgrep does.
fn configure_types(builder: &mut WalkBuilder, options: &NativeContentSearchOptions) -> Result<()> {
  let has_select = options.type_select.as_ref().is_some_and(|v| !v.is_empty());
  let has_negate = options.type_negate.as_ref().is_some_and(|v| !v.is_empty());
  if !has_select && !has_negate {
    return Ok(());
  }

  let mut types = TypesBuilder::new();
  for def in options.type_defs.iter().flatten() {
    types
      .add(&def.name, &def.glob)
      .map_err(|e| err("invalid type definition", e))?;
  }
  for name in options.type_select.iter().flatten() {
    types.select(name);
  }
  for name in options.type_negate.iter().flatten() {
    types.negate(name);
  }
  let matcher = types.build().map_err(|e| err("failed to build types", e))?;
  builder.types(matcher);
  Ok(())
}
