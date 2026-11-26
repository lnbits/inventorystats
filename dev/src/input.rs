use serde_json::Value;

pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn num(v: &Value, default: f64) -> f64 {
    match v {
        Value::Null => default,
        Value::Bool(b) => u8::from(*b) as f64,
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        _ => v.as_f64().unwrap_or(f64::NAN),
    }
}
pub fn i(v: &Value) -> i64 {
    num(v, 0.0) as i64
}
pub fn string_or<'a>(v: &'a Value, default: &'a str) -> &'a str {
    v.as_str().filter(|s| !s.is_empty()).unwrap_or(default)
}
