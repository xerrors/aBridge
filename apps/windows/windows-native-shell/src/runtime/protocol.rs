//! Interprets the deliberately small JSON Schema subset exported by the shared protocol.
//! Defaults and portable refinements are applied before typed deserialization.
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub protocol: String,
    pub capabilities: Vec<String>,
    pub tool_capabilities: BTreeMap<String, String>,
    pub limits: Limits,
    pub schemas: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub message_bytes: usize,
    pub image_bytes: usize,
    pub desktop_observation_seconds: f64,
    pub operations: usize,
    pub lease_seconds: f64,
    pub heartbeat_seconds: f64,
    pub operation_start_seconds: f64,
    pub operation_grace_seconds: f64,
}
pub fn contract() -> &'static Contract {
    static VALUE: OnceLock<Contract> = OnceLock::new();
    VALUE.get_or_init(|| {
        let c: Contract =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/contract.json")))
                .expect("Build-time protocol contract");
        for s in c.schemas.values() {
            check_schema(s).expect("Supported build-time protocol schema");
        }
        c
    })
}
pub fn parse(name: &str, value: Value) -> Result<Value> {
    validate(
        contract().schemas.get(name).context("Unsupported schema")?,
        value,
    )
}
// Fail closed when the shared contract adds syntax this interpreter cannot enforce.
pub fn check_schema(schema: &Value) -> Result<()> {
    let object = schema.as_object().context("Invalid schema")?;
    for (key, value) in object {
        match key.as_str() {
            "$schema" | "description" | "title" | "default" | "const" | "enum" | "required"
            | "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "minLength"
            | "maxLength" | "minItems" | "maxItems" | "x-trim" => {}
            "type" => ensure!(
                matches!(
                    value.as_str(),
                    Some("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
                ),
                "Unsupported schema type"
            ),
            "pattern" => {
                regex::Regex::new(value.as_str().context("Invalid pattern")?)?;
            }
            "format" => {
                ensure!(
                    value == "uri" || (value == "starts_with" && schema["pattern"].is_string()),
                    "Unsupported schema format"
                );
            }
            "x-rule" => check_rule(value)?,
            "properties" => {
                for child in value.as_object().context("Invalid properties")?.values() {
                    check_schema(child)?;
                }
            }
            "propertyNames" | "items" => check_schema(value)?,
            "additionalProperties" if value.is_boolean() => {}
            "additionalProperties" => check_schema(value)?,
            "anyOf" | "allOf" | "oneOf" => {
                for child in value.as_array().context("Invalid schema union")? {
                    check_schema(child)?;
                }
            }
            _ => bail!("Unsupported schema keyword: {key}"),
        }
    }
    Ok(())
}
fn check_rule(rule: &Value) -> Result<()> {
    let args = rule.as_array().context("Invalid portable rule")?;
    match args.first().and_then(Value::as_str) {
        Some("and" | "or" | "not") => {
            for sub in &args[1..] {
                check_rule(sub)?;
            }
        }
        Some("unique" | "exists" | "truthy" | "noNul" | "nonblank" | "unicode" | "utf8Max") => {}
        _ => bail!("Unsupported portable rule"),
    }
    Ok(())
}
fn rule_matches(rule: &Value, value: &Value) -> bool {
    let Some(args) = rule.as_array() else {
        return false;
    };
    let field = || {
        if args.get(1).and_then(Value::as_str) == Some("") {
            Some(value)
        } else {
            args.get(1)
                .and_then(Value::as_str)
                .and_then(|s| value.get(s))
        }
    };
    match args.first().and_then(Value::as_str) {
        Some("and") => args[1..].iter().all(|r| rule_matches(r, value)),
        Some("or") => args[1..].iter().any(|r| rule_matches(r, value)),
        Some("not") => args.get(1).is_some_and(|r| !rule_matches(r, value)),
        Some("exists") => field().is_some(),
        Some("truthy") => field().is_some_and(|v| match v {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64() != Some(0.),
            Value::String(s) => !s.is_empty(),
            _ => true,
        }),
        Some("unique") => value
            .as_array()
            .is_some_and(|a| a.iter().enumerate().all(|(i, v)| !a[..i].contains(v))),
        Some("noNul") => value.as_str().is_some_and(|s| !s.contains('\0')),
        Some("nonblank") => value
            .as_str()
            .is_some_and(|s| !s.trim_matches(js_whitespace).is_empty()),
        Some("unicode") => value.is_string(), // serde_json rejects unpaired surrogate escapes.
        Some("utf8Max") => value.as_str().is_some_and(|s| {
            args.get(1)
                .and_then(Value::as_u64)
                .is_some_and(|n| s.len() as u64 <= n)
        }),
        _ => false,
    }
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn validate(schema: &Value, mut value: Value) -> Result<Value> {
    if let Some(options) = schema["oneOf"].as_array() {
        let mut matches = options
            .iter()
            .filter_map(|s| validate(s, value.clone()).ok());
        let result = matches.next().context("Invalid discriminated union")?;
        ensure!(matches.next().is_none(), "Ambiguous discriminated union");
        return Ok(result);
    }
    if schema["x-trim"] == true {
        if let Some(s) = value.as_str() {
            value = Value::String(s.trim_matches(js_whitespace).to_owned());
        }
    }
    if let Some(options) = schema["anyOf"].as_array() {
        return options
            .iter()
            .find_map(|s| validate(s, value.clone()).ok())
            .context("Invalid union value");
    }
    if let Some(options) = schema["allOf"].as_array() {
        for s in options {
            value = validate(s, value)?;
        }
    }
    if let Some(expected) = schema.get("const") {
        ensure!(&value == expected, "Invalid constant");
    }
    if let Some(options) = schema["enum"].as_array() {
        ensure!(options.contains(&value), "Invalid enum");
    }
    match schema["type"].as_str() {
        Some("object") => {
            let object = value.as_object().context("Expected object")?;
            let empty = Map::new();
            let props = schema["properties"].as_object().unwrap_or(&empty);
            let mut result = Map::new();
            for (key, sub) in props {
                if let Some(v) = object.get(key).or_else(|| sub.get("default")) {
                    result.insert(key.clone(), validate(sub, v.clone())?);
                }
            }
            for (key, v) in object {
                if let Some(names) = schema.get("propertyNames") {
                    validate(names, Value::String(key.clone()))?;
                }
                if props.contains_key(key) {
                    continue;
                }
                match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => bail!("Unexpected property"),
                    Some(Value::Object(_)) => {
                        result.insert(
                            key.clone(),
                            validate(&schema["additionalProperties"], v.clone())?,
                        );
                    }
                    Some(Value::Bool(true)) => {
                        result.insert(key.clone(), v.clone());
                    }
                    None => {} // Zod's default object policy strips unknown fields.
                    _ => bail!("Invalid property schema"),
                }
            }
            if let Some(required) = schema["required"].as_array() {
                for key in required {
                    ensure!(
                        result.contains_key(key.as_str().context("Invalid required field")?),
                        "Missing field"
                    );
                }
            }
            value = Value::Object(result);
        }
        Some("array") => {
            let a = value.as_array().context("Expected array")?;
            bound(schema, "minItems", "maxItems", a.len() as f64)?;
            if let Some(items) = schema.get("items") {
                value = Value::Array(
                    a.iter()
                        .map(|v| validate(items, v.clone()))
                        .collect::<Result<_>>()?,
                );
            }
        }
        Some("string") => {
            let s = value.as_str().context("Expected string")?;
            if schema["format"] == "uri" {
                url::Url::parse(s).context("Invalid URI")?;
            }
            // Preserve the Windows Zod runtime's JavaScript string.length semantics.
            bound(
                schema,
                "minLength",
                "maxLength",
                s.encode_utf16().count() as f64,
            )?;
            if let Some(pattern) = schema["pattern"].as_str() {
                ensure!(
                    regex::Regex::new(pattern)?.is_match(s),
                    "Invalid string pattern"
                );
            }
        }
        Some("number" | "integer") => {
            let n = value.as_f64().context("Expected number")?;
            ensure!(n.is_finite(), "Non-finite number");
            if schema["type"] == "integer" {
                ensure!(n.fract() == 0., "Expected integer");
                value = Value::from(n as i64);
            }
            bound(schema, "minimum", "maximum", n)?;
            if let Some(min) = schema["exclusiveMinimum"].as_f64() {
                ensure!(n > min, "Number too small");
            }
            if let Some(max) = schema["exclusiveMaximum"].as_f64() {
                ensure!(n < max, "Number too large");
            }
        }
        Some("boolean") => ensure!(value.is_boolean(), "Expected boolean"),
        Some("null") => ensure!(value.is_null(), "Expected null"),
        None => {}
        _ => bail!("Unsupported schema type"),
    }
    if let Some(rule) = schema.get("x-rule") {
        ensure!(rule_matches(rule, &value), "Invalid portable constraint");
    }
    Ok(value)
}
fn bound(schema: &Value, min: &str, max: &str, n: f64) -> Result<()> {
    if let Some(v) = schema[min].as_f64() {
        ensure!(n >= v, "Below minimum");
    }
    if let Some(v) = schema[max].as_f64() {
        ensure!(n <= v, "Above maximum");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exported_contract_is_supported() {
        for s in contract().schemas.values() {
            check_schema(s).unwrap();
        }
    }
    #[test]
    fn shared_defaults_and_constraints() {
        assert_eq!(
            parse("command_execute", json!({"command":"pwd"})).unwrap()["timeout"],
            30
        );
        for value in [
            json!({"command":"  "}),
            json!({"command":"x\u{0000}"}),
            json!({"command":"pwd","env":{"A=B":"x"}}),
            json!({"command":"pwd","surprise":true}),
        ] {
            assert!(parse("command_execute", value).is_err());
        }
        assert!(parse(
            "file_write",
            json!({"path":"x","content":"a".repeat(1048577)})
        )
        .is_err());
        assert!(parse("files_list", json!({"path":"x","limit":1.5})).is_err());
        assert_eq!(
            parse("files_list", json!({"path":"x","limit":1.0})).unwrap()["limit"],
            1
        );
    }
    #[test]
    fn fails_closed_for_new_rules() {
        assert!(check_schema(&json!({"format":"email"})).is_err());
        assert!(check_schema(&json!({"x-rule":["newRule"]})).is_err());
    }
    #[test]
    fn rename_length_matches_javascript_utf16_units() {
        assert!(parse("deviceRename", json!({"name":"😀".repeat(60)})).is_ok());
        assert!(parse("deviceRename", json!({"name":"😀".repeat(61)})).is_err());
        assert!(parse("deviceRename", json!({"name":"a".repeat(120)})).is_ok());
        assert!(parse("deviceRename", json!({"name":"a".repeat(121)})).is_err());
    }
}
