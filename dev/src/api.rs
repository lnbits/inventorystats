use crate::{date, host, input::*, stats, Reply};
use serde_json::{json, Value};

pub fn get_inventory_stats(req: &Value) -> Reply {
    let days = match i(&req["days"]) {
        n @ (0 | 7 | 30 | 90 | 365) => n,
        _ => 30,
    };
    let now = host::now() as i64;
    let inventory = request("/api/v1", "Inventory")?;
    if inventory.is_null() {
        return Err("No inventory was found. Create one in the Inventory extension first.".into());
    }
    let id = encode(s(&inventory["id"]));
    let (items, item_total) = pages("Inventory items", 50, 5000, |offset| {
        format!("/api/v1/items/{id}/paginated?limit=50&offset={offset}&sortby=name&direction=asc")
    })?;
    let cutoff = if days > 0 {
        format!("&created_at[ge]={}", encode(&date::iso(now - days * 86400)))
    } else {
        String::new()
    };
    let (logs, log_total) = pages("Inventory sales history", 250, 10000, |offset| {
        format!("/api/v1/logs/{id}/paginated?limit=250&offset={offset}&sortby=created_at&direction=asc&source=webshop{cutoff}")
    })?;
    let mut report = stats::build(&inventory, &items, &logs, days, now);
    report["dataQuality"] = json!({"itemCount":items.len(),"itemTotal":item_total,"itemsTruncated":items.len()<item_total,"salesLogCount":logs.len(),"salesLogTotal":log_total,"salesLogsTruncated":logs.len()<log_total});
    let mut warnings = Vec::new();
    if items.len() < item_total {
        warnings.push(format!(
            "Only {} of {item_total} items were analysed.",
            items.len()
        ));
    }
    if logs.len() < log_total {
        warnings.push(format!(
            "Only {} of {log_total} sales movements were analysed.",
            logs.len()
        ));
    }
    let summary = &report["summary"];
    let untracked = i(&summary["untrackedItemCount"]);
    if untracked != 0 {
        warnings.push(format!(
            "{untracked} item(s) have no tracked stock quantity."
        ));
    }
    let coverage = num(&summary["costCoverage"], 0.);
    if coverage < 100. {
        warnings.push(format!(
            "Cost and margin figures cover {coverage}% of tracked item records."
        ));
    }
    let low = i(&summary["lowStockCount"]);
    if low > 100 {
        warnings.push(format!(
            "The reorder table shows the first 100 of {low} low-stock items."
        ));
    }
    report["warnings"] = json!(warnings);
    host::log(
        &format!(
            "inventorystats: analysed {} items and {} webshop stock movements",
            items.len(),
            logs.len()
        ),
        "info",
    );
    Ok(report)
}
fn request(path: &str, label: &str) -> Reply {
    let (status, body) = host::extension("inventory", "GET", path, None);
    match status {
        200 if body.is_empty() => Ok(Value::Null),
        200 => serde_json::from_str(&body).map_err(|_| format!("{label} returned invalid JSON.")),
        404 => Err(format!(
            "{label} is unavailable. Check that Inventory is enabled."
        )),
        _ => Err(format!("{label} returned HTTP {status}.")),
    }
}
fn pages(
    label: &str,
    size: usize,
    max: usize,
    path: impl Fn(usize) -> String,
) -> Result<(Vec<Value>, usize), String> {
    let mut rows = Vec::new();
    let mut total = 0;
    while rows.len() < max {
        let mut page = request(&path(rows.len()), label)?;
        let count = page
            .get("total")
            .map(|v| num(v, 0.))
            .filter(|n| n.is_finite());
        let data = page["data"].as_array_mut();
        let (Some(count), Some(data)) = (count, data) else {
            return Err(format!("{label} returned an invalid paginated response."));
        };
        let received = data.len();
        total = count.max(0.) as usize;
        rows.extend(data.drain(..).take(max - rows.len()));
        if received < size || rows.len() >= total {
            break;
        }
    }
    Ok((rows, total))
}
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
