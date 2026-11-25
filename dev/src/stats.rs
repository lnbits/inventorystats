use crate::{date, input::*};
use serde_json::{json, Value};
use std::{cmp::Ordering, collections::BTreeMap};
struct Item<'a> {
    id: &'a str,
    name: &'a str,
    sku: &'a str,
    category: &'a str,
    qty: Option<f64>,
    price: f64,
    cost: Option<f64>,
    threshold: Option<f64>,
    active: bool,
    approved: bool,
}
impl<'a> Item<'a> {
    fn read(r: &'a Value, inventory: &Value) -> Self {
        let discount = finite(if r["discount_percentage"].is_null() {
            &inventory["global_discount_percentage"]
        } else {
            &r["discount_percentage"]
        })
        .clamp(0., 100.);
        let tracked =
            |field: &str| (!r[field].is_null()).then(|| finite(&r[field]).trunc().max(0.));
        Self {
            id: s(&r["id"]),
            name: string_or(&r["name"], "Unnamed item").trim(),
            sku: s(&r["sku"]).trim(),
            category: s(&r["tags"])
                .split(',')
                .map(str::trim)
                .find(|s| !s.is_empty())
                .unwrap_or("Uncategorised"),
            qty: tracked("quantity_in_stock"),
            price: finite(&r["price"]).max(0.) * (1. - discount / 100.),
            cost: (!r["unit_cost"].is_null()).then(|| finite(&r["unit_cost"]).max(0.)),
            threshold: tracked("reorder_threshold"),
            active: r["is_active"] != false,
            approved: r["is_approved"] != false,
        }
    }
    fn reorder(&self) -> bool {
        self.active
            && self.approved
            && self
                .qty
                .zip(self.threshold)
                .is_some_and(|(qty, threshold)| qty <= threshold)
    }
}
#[derive(Default)]
struct Sale {
    units: f64,
    revenue: f64,
    cost: f64,
    costed: f64,
}
pub fn build(inv: &Value, raw: &[Value], logs: &[Value], days: i64, now: i64) -> Value {
    let items: Vec<_> = raw.iter().map(|r| Item::read(r, inv)).collect();
    let by_id: BTreeMap<_, _> = items.iter().map(|r| (r.id, r)).collect();
    let mut sales = BTreeMap::<&str, Sale>::new();
    let mut trend = BTreeMap::<String, (f64, f64)>::new();
    let mut earliest = None;
    let monthly = matches!(days, 0 | 365);
    for log in logs {
        let units = -finite(&log["quantity_change"]).trunc();
        if units <= 0. {
            continue;
        }
        let id = string_or(&log["item_id"], "unknown");
        let item = by_id.get(id);
        let revenue = units * item.map_or(0., |i| i.price);
        let sale = sales.entry(id).or_default();
        sale.units += units;
        sale.revenue += revenue;
        if let Some(cost) = item.and_then(|i| i.cost) {
            sale.cost += units * cost;
            sale.costed += units;
        }
        let bucket = if let Some(ms) = date::milliseconds(s(&log["created_at"])).filter(|t| *t != 0)
        {
            earliest = Some(earliest.map_or(ms, |old: i64| old.min(ms)));
            let iso = date::iso(ms.div_euclid(1000));
            iso[..if monthly { 7 } else { 10 }].to_owned()
        } else {
            "Unknown".into()
        };
        let t = trend.entry(bucket).or_default();
        t.0 += units;
        t.1 += revenue;
    }
    let observed = if days > 0 {
        days
    } else {
        earliest.map_or(1, |ms| {
            ((now * 1000 - ms) as f64 / 86400000.).ceil().max(1.) as i64
        })
    };
    let empty = Sale::default();
    let rows: Vec<_> = items
        .iter()
        .map(|r| performance(Some(r), r.id, sales.get(r.id).unwrap_or(&empty), observed))
        .collect();
    let mut sold = rows
        .iter()
        .filter(|r| n(r, "unitsSold") > 0.)
        .cloned()
        .collect::<Vec<_>>();
    sold.extend(
        sales
            .iter()
            .filter(|(id, _)| !by_id.contains_key(*id))
            .map(|(id, sale)| performance(None, id, sale, observed)),
    );
    sort(
        &mut sold,
        &[("unitsSold", false), ("estimatedRevenue", false)],
    );
    let leaders = rank(
        &rows,
        |r| !r["quantityInStock"].is_null(),
        &[("quantityInStock", false)],
        10,
    );
    let reorder = rank(
        &rows,
        |r| r["needsReorder"] == true,
        &[("quantityInStock", true), ("unitsSold", false)],
        100,
    );
    let slow = rank(
        &rows,
        |r| {
            n(r, "quantityInStock") > 0.
                && n(r, "unitsSold") == 0.
                && r["active"] == true
                && r["approved"] == true
        },
        &[("retailValue", false)],
        20,
    );
    let revenue = sold.iter().map(|r| n(r, "estimatedRevenue")).sum();
    let mut cumulative = 0.;
    let abc: Vec<_> = sold
        .iter()
        .take(100)
        .map(|r| {
            let mut row = r.clone();
            let share = ratio(n(r, "estimatedRevenue"), revenue);
            row["grade"] = json!(if cumulative < 80. {
                "A"
            } else if cumulative < 95. {
                "B"
            } else {
                "C"
            });
            cumulative += share;
            row["revenueShare"] = json!(round(share, 1));
            row["cumulativeRevenueShare"] = json!(round(cumulative, 1));
            row
        })
        .collect();
    json!({"inventory":{"id":s(&inv["id"]),"name":string_or(&inv["name"],"Inventory").trim(),"currency":string_or(&inv["currency"],"SAT").trim().to_uppercase()},
        "generatedAt":now,"period":{"days":days,"observedDays":observed,"label":if days>0{format!("Last {days} days")}else{"All recorded history".into()},"trendGrain":if monthly{"month"}else{"day"}},
        "salesBasis":"Paid webshop stock deductions","summary":summary(&items,&sold),"trend":trend.into_iter().map(|(label,(units,revenue))|json!({"label":label,"units":units,"revenue":revenue})).collect::<Vec<_>>(),
        "topSellers":&sold[..sold.len().min(10)],"stockLeaders":leaders,"categories":categories(&rows),"reorderWatch":reorder,"slowMovers":slow,"abc":abc})
}
fn performance(item: Option<&Item>, id: &str, sale: &Sale, days: i64) -> Value {
    let qty = item.and_then(|i| i.qty);
    let tracked = qty.unwrap_or(0.);
    let velocity = sale.units / days.max(1) as f64;
    json!({"id":id,"name":item.map_or("Deleted item",|i|i.name),"sku":item.map_or("",|i|i.sku),"category":item.map_or("Deleted item",|i|i.category),
        "quantityInStock":qty,"reorderThreshold":item.and_then(|i|i.threshold),"active":item.is_some_and(|i|i.active),"approved":item.is_some_and(|i|i.approved),
        "unitsSold":sale.units,"estimatedRevenue":round(sale.revenue,2),"estimatedGrossProfit":(sale.costed==sale.units).then(||round(sale.revenue-sale.cost,2)),
        "salesVelocity":round(velocity,3),"daysOfCover":qty.filter(|_|velocity>0.).map(|q|round(q/velocity,1)),"sellThrough":round(ratio(sale.units,sale.units+tracked),1),
        "retailValue":round(tracked*item.map_or(0.,|i|i.price),2),"costValue":item.and_then(|i|i.cost).map(|c|round(tracked*c,2)),"needsReorder":item.is_some_and(Item::reorder)})
}
fn summary(items: &[Item], sold: &[Value]) -> Value {
    let tracked = items.iter().filter(|i| i.qty.is_some()).count();
    let mut costed = 0;
    let (mut stock, mut retail, mut cost, mut priced) = (0., 0., 0., 0.);
    for i in items {
        if let Some(qty) = i.qty {
            stock += qty;
            retail += qty * i.price;
            if let Some(c) = i.cost {
                costed += 1;
                cost += qty * c;
                priced += qty * i.price;
            }
        }
    }
    let sum = |key| sold.iter().map(|r| n(r, key)).sum::<f64>();
    let units = sum("unitsSold");
    json!({"itemCount":items.len(),"activeItemCount":items.iter().filter(|i|i.active&&i.approved).count(),"pendingItemCount":items.iter().filter(|i|!i.approved).count(),"inactiveItemCount":items.iter().filter(|i|!i.active).count(),
        "trackedItemCount":tracked,"untrackedItemCount":items.len()-tracked,"stockUnits":stock,"retailValue":round(retail,2),"knownCostValue":round(cost,2),"costCoverage":round(ratio(costed as f64,tracked as f64),1),
        "potentialGrossProfit":round(priced-cost,2),"outOfStockCount":items.iter().filter(|i|i.active&&i.approved&&i.qty==Some(0.)).count(),"lowStockCount":items.iter().filter(|i|i.reorder()).count(),
        "unitsSold":units,"estimatedRevenue":round(sum("estimatedRevenue"),2),"estimatedGrossProfit":round(sum("estimatedGrossProfit"),2),
        "profitCoverage":round(ratio(sold.iter().filter(|r|!r["estimatedGrossProfit"].is_null()).count() as f64,sold.len() as f64),1),"sellThrough":round(ratio(units,units+stock),1)})
}
fn categories(rows: &[Value]) -> Vec<Value> {
    let mut cats = BTreeMap::<&str, [f64; 6]>::new();
    for r in rows {
        let c = cats.entry(s(&r["category"])).or_default();
        for (k, inc) in [
            1.,
            n(r, "quantityInStock"),
            n(r, "retailValue"),
            n(r, "unitsSold"),
            n(r, "estimatedRevenue"),
            if r["needsReorder"] == true { 1. } else { 0. },
        ]
        .into_iter()
        .enumerate()
        {
            c[k] += inc;
        }
    }
    let fields = [
        "itemCount",
        "stockUnits",
        "retailValue",
        "unitsSold",
        "estimatedRevenue",
        "lowStockCount",
    ];
    let mut result: Vec<_> = cats
        .into_iter()
        .map(|(name, values)| {
            let mut r = json!({"name":name});
            for (key, num) in fields.iter().zip(values) {
                r[key] = json!(round(num, 2));
            }
            r
        })
        .collect();
    sort(&mut result, &[("retailValue", false), ("unitsSold", false)]);
    if result.len() > 20 {
        let mut other = json!({"name":"Other categories"});
        for key in fields {
            other[key] = json!(result[19..].iter().map(|r| n(r, key)).sum::<f64>());
        }
        result.truncate(19);
        result.push(other);
    }
    result
}
fn rank(
    rows: &[Value],
    include: impl Fn(&Value) -> bool,
    keys: &[(&str, bool)],
    limit: usize,
) -> Vec<Value> {
    let mut ranked = rows
        .iter()
        .filter(|r| include(r))
        .cloned()
        .collect::<Vec<_>>();
    sort(&mut ranked, keys);
    ranked.truncate(limit);
    ranked
}
fn sort(rows: &mut [Value], keys: &[(&str, bool)]) {
    rows.sort_by(|a, b| {
        for (key, ascending) in keys {
            let ord = n(a, key).total_cmp(&n(b, key));
            if ord != Ordering::Equal {
                return if *ascending { ord } else { ord.reverse() };
            }
        }
        s(&a["name"])
            .to_lowercase()
            .cmp(&s(&b["name"]).to_lowercase())
    });
}
fn finite(v: &Value) -> f64 {
    let n = num(v, 0.);
    if n.is_finite() {
        n
    } else {
        0.
    }
}
fn n(r: &Value, key: &str) -> f64 {
    finite(&r[key])
}
fn ratio(num: f64, den: f64) -> f64 {
    if den > 0. {
        num / den * 100.
    } else {
        0.
    }
}
fn round(value: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    ((value + f64::EPSILON) * f + 0.5).floor() / f
}
