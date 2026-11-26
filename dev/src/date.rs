// Gregorian calendar conversions using 400-year eras, with day zero at Unix epoch.
fn civil_days(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}
pub fn iso(timestamp: i64) -> String {
    let z = timestamp.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let sec = timestamp.rem_euclid(86400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        sec / 3600,
        sec / 60 % 60,
        sec % 60
    )
}
pub fn milliseconds(value: &str) -> Option<i64> {
    let val = value.trim();
    let number = |a, b| val.get(a..b)?.parse::<i64>().ok();
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    if val.get(4..5) != Some("-")
        || val.get(7..8) != Some("-")
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let mut secs = civil_days(year, month, day) * 86400;
    let mut fraction = 0;
    if val.len() > 10 {
        if !matches!(val.get(10..11), Some("T" | " ")) {
            return None;
        }
        let hour = number(11, 13)?;
        let min = number(14, 16)?;
        let mut end = 16;
        let mut sec = 0;
        if val.get(16..17) == Some(":") {
            sec = number(17, 19)?;
            end = 19;
        }
        if hour > 24 || min > 59 || sec > 59 {
            return None;
        }
        secs += hour * 3600 + min * 60 + sec;
        if val.get(end..end + 1) == Some(".") {
            end += 1;
            let start = end;
            while val.as_bytes().get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            for (index, digit) in val.as_bytes()[start..end].iter().take(3).enumerate() {
                fraction += i64::from(*digit - b'0') * [100, 10, 1][index];
            }
        }
        let zone = val.get(end..)?;
        if !zone.is_empty() && zone != "Z" && zone != "z" {
            let sign = match zone.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let zone = zone[1..].replace(':', "");
            if zone.len() != 4 {
                return None;
            }
            let zh = zone.get(0..2)?.parse::<i64>().ok()?;
            let zm = zone.get(2..4)?.parse::<i64>().ok()?;
            if zh > 23 || zm > 59 {
                return None;
            }
            secs -= sign * (zh * 3600 + zm * 60);
        }
    }
    Some(secs * 1000 + fraction)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utc_and_offsets() {
        for (date, utc) in [
            ("2024-03-01T00:15:00+01:00", "2024-02-29T23:15:00.000Z"),
            ("1969-12-31T23:59:59Z", "1969-12-31T23:59:59.000Z"),
        ] {
            assert_eq!(iso(milliseconds(date).unwrap().div_euclid(1000)), utc);
        }
    }
}
