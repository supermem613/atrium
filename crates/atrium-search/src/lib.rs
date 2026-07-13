#![deny(clippy::all)]

use napi::bindgen_prelude::{AsyncTask, Task};
use napi::{Env, Result};
use napi_derive::napi;

mod common;
mod content;
mod files;

/// Structured content-search request. Field names mirror the TS
/// `NativeContentSearchOptions` seam so the addon can replace the rg-spawn
/// runner without the TS normalize layer changing shape.
#[napi(object)]
pub struct NativeContentSearchOptions {
  pub root: String,
  pub query: String,
  pub regex: Option<bool>,
  pub all: Option<bool>,
  pub globs: Option<Vec<String>>,
  pub excludes: Option<Vec<String>>,
  pub type_defs: Option<Vec<NativeTypeDef>>,
  pub type_select: Option<Vec<String>>,
  pub type_negate: Option<Vec<String>>,
  pub max: Option<u32>,
  pub timeout_ms: Option<u32>,
  pub perf: Option<bool>,
}

/// One ripgrep-style file-type definition, e.g. name `xraycode`, glob `*.ts`.
/// Multiple entries may share a name to build up a type from several globs.
#[napi(object)]
pub struct NativeTypeDef {
  pub name: String,
  pub glob: String,
}

/// Structured file-listing request mirroring `NativeFilesSearchOptions`.
#[napi(object)]
pub struct NativeFilesSearchOptions {
  pub root: String,
  pub all: Option<bool>,
  pub globs: Option<Vec<String>>,
  pub excludes: Option<Vec<String>>,
  pub max: Option<u32>,
  pub timeout_ms: Option<u32>,
  pub perf: Option<bool>,
  pub root_is_file: Option<bool>,
  pub root_name: Option<String>,
}

#[napi(object)]
pub struct NativeContentMatch {
  pub path: String,
  pub line: u32,
  pub text: String,
}

#[napi(object)]
pub struct NativeSearchMetrics {
  pub searches: u32,
  pub child_run_ms: f64,
}

#[napi(object)]
pub struct NativeContentResult {
  pub matches: Vec<NativeContentMatch>,
  pub truncated: bool,
  pub timed_out: bool,
  pub metrics: Option<NativeSearchMetrics>,
}

#[napi(object)]
pub struct NativeFilesResult {
  pub paths: Vec<String>,
  pub truncated: bool,
  pub timed_out: bool,
  pub metrics: Option<NativeSearchMetrics>,
}

pub struct ContentTask {
  options: NativeContentSearchOptions,
}

impl Task for ContentTask {
  type Output = NativeContentResult;
  type JsValue = NativeContentResult;

  fn compute(&mut self) -> Result<Self::Output> {
    let outcome = content::search(&self.options)?;
    Ok(NativeContentResult {
      matches: outcome.matches,
      truncated: outcome.truncated,
      timed_out: outcome.timed_out,
      metrics: outcome.metrics,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

pub struct FilesTask {
  options: NativeFilesSearchOptions,
}

impl Task for FilesTask {
  type Output = NativeFilesResult;
  type JsValue = NativeFilesResult;

  fn compute(&mut self) -> Result<Self::Output> {
    let outcome = files::search(&self.options)?;
    Ok(NativeFilesResult {
      paths: outcome.paths,
      truncated: outcome.truncated,
      timed_out: outcome.timed_out,
      metrics: outcome.metrics,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi(ts_return_type = "Promise<NativeContentResult>")]
pub fn search_content(options: NativeContentSearchOptions) -> AsyncTask<ContentTask> {
  AsyncTask::new(ContentTask { options })
}

#[napi(ts_return_type = "Promise<NativeFilesResult>")]
pub fn search_files(options: NativeFilesSearchOptions) -> AsyncTask<FilesTask> {
  AsyncTask::new(FilesTask { options })
}
