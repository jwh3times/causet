//! Answers one JSON request per stdin line with one JSON line, so
//! `test/rust-model.test.js` can put this crate and `src/` side by side on the
//! same inputs in a single process. Not part of any shipped command.
#![forbid(unsafe_code)]

use causet_model::canonical::{
  CANONICAL_JSON_PROFILE, canonical_json, hashed_payload, legacy_canonical_json,
};
use causet_model::ids::{
  ID_ENTROPY_BITS, ID_NAMESPACES, LOGICAL_ID_PROFILE, ParsedId, new_id, parse_logical_id,
};
use causet_model::json::{
  Object, Value, js, lossy, object, parse, string, stringify, stringify_pretty,
};
use causet_model::registry::*;
use causet_model::schemas::*;
use std::io::{BufRead, Write};

fn main() {
  let stdin = std::io::stdin();
  let mut stdout = std::io::stdout().lock();
  for line in stdin.lock().lines() {
    let line = line.expect("stdin");
    if line.trim().is_empty() {
      continue;
    }
    let reply = match parse(&line) {
      Ok(request) => answer(&request),
      Err(error) => object([("requestError", string(&error))]),
    };
    writeln!(stdout, "{}", stringify(&reply)).expect("stdout");
  }
}

fn text(request: &Value, name: &str) -> Option<String> {
  match request {
    Value::Object(object) => match object.get(name) {
      Some(Value::String(units)) => Some(lossy(units)),
      _ => None,
    },
    _ => None,
  }
}

fn member<'a>(request: &'a Value, name: &str) -> Option<&'a Value> {
  match request {
    Value::Object(object) => object.get(name),
    _ => None,
  }
}

/// The JSON document a request carries as text, parsed here as `JSON.parse` would.
fn document(request: &Value) -> Result<Value, Value> {
  parse(&text(request, "text").unwrap_or_default())
    .map_err(|_| object([("parseError", Value::Bool(true))]))
}

fn strings(items: &[&str]) -> Value {
  Value::Array(items.iter().map(|item| string(item)).collect())
}

fn numbers(items: &[u32]) -> Value {
  Value::Array(
    items
      .iter()
      .map(|item| Value::Number(f64::from(*item)))
      .collect(),
  )
}

fn optional_number(value: Option<f64>) -> Value {
  value.map_or(Value::Null, Value::Number)
}

fn optional_string(value: Option<&str>) -> Value {
  value.map_or(Value::Null, string)
}

fn answer(request: &Value) -> Value {
  let thrown = || object([("thrown", Value::Bool(true))]);
  match text(request, "op").as_deref() {
    Some("canonical") | Some("hashed") => {
      let value = match document(request) {
        Ok(value) => value,
        Err(reply) => return reply,
      };
      let result = if text(request, "op").as_deref() == Some("hashed") {
        hashed_payload(&value)
      } else {
        canonical_json(&value)
      };
      match result {
        Ok(bytes) => object([
          ("canonical", string(&bytes)),
          (
            "sha256",
            string(&causet_model::sha256::hex(bytes.as_bytes())),
          ),
        ]),
        Err(error) => object([("error", string(&error.0))]),
      }
    }
    Some("serialize") => match document(request) {
      Ok(value) => object([
        ("compact", string(&stringify(&value))),
        ("pretty", string(&stringify_pretty(&value))),
        ("legacy", string(&legacy_canonical_json(&value))),
        (
          "digest",
          string(&causet_model::canonical::record_digest(
            "0000000000000000000000000000000000000000",
            &value,
          )),
        ),
      ]),
      Err(reply) => reply,
    },
    Some("validate") => match document(request) {
      Ok(value) => {
        let format = text(request, "format").unwrap_or_else(|| "sha1".into());
        match validate_note_record(Some(&value), &format) {
          Ok(errors) => object([(
            "errors",
            Value::Array(
              errors
                .iter()
                .map(|error| {
                  object([
                    ("field", string(&error.field)),
                    ("expectation", string(&error.expectation)),
                  ])
                })
                .collect(),
            ),
          )]),
          Err(Thrown) => thrown(),
        }
      }
      Err(reply) => reply,
    },
    Some("refs") => match document(request) {
      Ok(value) => match referenced_objects(Some(&value)) {
        Ok(objects) => object([(
          "objects",
          Value::Array(
            objects
              .into_iter()
              .map(|reference| {
                object([
                  ("oid", Value::String(reference.oid)),
                  ("type", string(reference.kind)),
                  ("field", string(&reference.field)),
                ])
              })
              .collect(),
          ),
        )]),
        Err(Thrown) => thrown(),
      },
      Err(reply) => reply,
    },
    Some("signature") => match document(request) {
      Ok(value) => match resolution_signature(Some(&value)) {
        Ok(signature) => object([("signature", string(&signature))]),
        Err(Thrown) => thrown(),
      },
      Err(reply) => reply,
    },
    Some("classify") => {
      let schema = member(request, "schema").and_then(|value| match value {
        Value::String(units) => Some(lossy(units)),
        _ => None,
      });
      let classification = schema_classification(schema.as_deref());
      let compatibility = schema_compatibility(schema.as_deref());
      object([
        (
          "classification",
          object([
            ("known", Value::Bool(classification.known)),
            ("family", optional_string(classification.family.as_deref())),
            ("version", optional_number(classification.version)),
            ("scope", optional_string(classification.scope)),
            ("legacyName", Value::Bool(classification.legacy_name)),
          ]),
        ),
        (
          "compatibility",
          object([
            ("family", optional_string(compatibility.family.as_deref())),
            ("version", optional_number(compatibility.version)),
            (
              "policy",
              optional_string(compatibility.policy.map(|family| family.name)),
            ),
            (
              "scope",
              optional_string(compatibility.policy.map(|family| family.scope)),
            ),
            ("readable", Value::Bool(compatibility.readable)),
            ("migrated", Value::Bool(compatibility.migrated)),
            ("disposition", string(compatibility.disposition)),
          ]),
        ),
      ])
    }
    Some("readable") => {
      let schema = member(request, "schema").and_then(|value| match value {
        Value::String(units) => Some(lossy(units)),
        _ => None,
      });
      let family = text(request, "family");
      let subject = text(request, "subject").unwrap_or_default();
      let recovery = text(request, "recovery").unwrap_or_default();
      match assert_readable_schema(schema.as_deref(), &subject, family.as_deref(), &recovery) {
        Ok(()) => object([("readable", Value::Bool(true))]),
        Err(refusal) => object([
          ("code", string(refusal.code)),
          ("message", string(&refusal.message)),
          ("details", string(&refusal.details)),
        ]),
      }
    }
    Some("logical-id") => {
      let value = member(request, "value").and_then(|value| match value {
        Value::String(units) => Some(lossy(units)),
        _ => None,
      });
      match parse_logical_id(value.as_deref()) {
        ParsedId::Valid {
          namespace,
          minted,
          random,
        } => object([
          ("valid", Value::Bool(true)),
          ("namespace", string(&namespace)),
          ("minted", string(&minted)),
          ("random", string(&random)),
        ]),
        ParsedId::Invalid { reason, namespace } => {
          let mut reply = Object::new();
          reply.set("valid", Value::Bool(false));
          reply.set("reason", string(reason));
          if let Some(namespace) = namespace {
            reply.set("namespace", string(&namespace));
          }
          Value::Object(reply)
        }
      }
    }
    Some("new-id") => match new_id(&text(request, "prefix").unwrap_or_default()) {
      Ok(id) => object([("id", string(&id))]),
      Err(error) => object([("error", string(&error))]),
    },
    Some("sha256") => object([(
      "hex",
      string(&causet_model::sha256::hex(
        text(request, "data").unwrap_or_default().as_bytes(),
      )),
    )]),
    Some("date") => object([(
      "valid",
      Value::Bool(causet_model::dates::parses(
        &text(request, "value").unwrap_or_default(),
      )),
    )]),
    Some("registry") => registry(),
    other => object([("requestError", string(&format!("unknown op {other:?}")))]),
  }
}

fn registry() -> Value {
  let mut families = Vec::new();
  for family in RECORD_FAMILIES {
    families.push(object([
      ("name", string(family.name)),
      ("scope", string(family.scope)),
      ("registered", numbers(family.registered)),
      ("readable", numbers(family.readable)),
      ("written", numbers(family.written)),
      ("unknownVersion", string(family.unknown_version)),
      ("store", string(family.store)),
    ]));
  }
  let mut bounds = Object::new();
  for (name, value) in RESOURCE_BOUNDS {
    bounds.set(name, Value::Number(*value as f64));
  }
  let mut codes = Object::new();
  for (code, meaning) in ERROR_CODES {
    codes.set(code, string(meaning));
  }
  let mut namespaces = Object::new();
  for (name, meaning) in ID_NAMESPACES {
    namespaces.insert(js(name), string(meaning));
  }
  object([
    ("families", Value::Array(families)),
    ("bounds", Value::Object(bounds)),
    ("exchangedScopes", strings(EXCHANGED_SCOPES)),
    ("exchangeFeatures", strings(EXCHANGE_FEATURES)),
    ("provenanceRoles", strings(PROVENANCE_ROLE_NAMES)),
    (
      "resolutionAlgorithm",
      string(RESOLUTION_SIGNATURE_ALGORITHM),
    ),
    ("lineageAlgorithm", string(METADATA_LINEAGE_ALGORITHM)),
    ("errorEnvelopeSchema", string(ERROR_ENVELOPE_SCHEMA)),
    ("errorCodes", Value::Object(codes)),
    ("idNamespaces", Value::Object(namespaces)),
    ("idEntropyBits", Value::Number(f64::from(ID_ENTROPY_BITS))),
    ("canonicalProfile", string(CANONICAL_JSON_PROFILE)),
    ("logicalIdProfile", string(LOGICAL_ID_PROFILE)),
    ("schemaNamespace", string(SCHEMA_NAMESPACE)),
    ("legacyNamespace", string(LEGACY_SCHEMA_NAMESPACE)),
  ])
}
