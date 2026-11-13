//! `CliError` as the Git engine raises it: a message, a published code from
//! the error vocabulary (ADR-0021), details, and the exit code.

use causet_model::errors::is_published_code;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitError {
  pub message: String,
  pub code: &'static str,
  pub details: String,
  pub exit_code: i32,
}

impl GitError {
  /// A code outside the vocabulary is a defect at the raise site, as it is in
  /// `src/errors.js`.
  pub fn new(code: &'static str, message: impl Into<String>) -> Self {
    assert!(
      is_published_code(code),
      "'{code}' is not a published causet error code."
    );
    Self {
      message: message.into(),
      code,
      details: String::new(),
      exit_code: 1,
    }
  }

  pub fn details(mut self, details: impl Into<String>) -> Self {
    self.details = details.into();
    self
  }

  pub fn exit_code(mut self, exit_code: i32) -> Self {
    self.exit_code = exit_code;
    self
  }
}

impl std::fmt::Display for GitError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(&self.message)
  }
}

impl std::error::Error for GitError {}

pub type GitResult<T> = Result<T, GitError>;
