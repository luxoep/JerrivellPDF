// SPDX-License-Identifier: MIT OR Apache-2.0
// Bounded text assistance. Original punctuation, signs and tolerances survive.
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChange {
    pub old: String,
    pub new: String,
    pub dimension_like: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAssistance {
    pub status: String,
    pub changes: Vec<TextChange>,
    pub limited: bool,
}
pub fn compare(a: &str, b: &str) -> TextAssistance {
    let tokens = |s: &str| {
        s.split_whitespace()
            .map(str::to_owned)
            .take(1001)
            .collect::<Vec<_>>()
    };
    let (a, b) = (tokens(a), tokens(b));
    let limited = a.len() > 1000 || b.len() > 1000;
    if limited {
        return TextAssistance {
            status: "limited".into(),
            changes: vec![],
            limited: true,
        };
    }
    if a.is_empty() || b.is_empty() {
        return TextAssistance {
            status: "visual-only".into(),
            changes: vec![],
            limited: false,
        };
    }
    let w = b.len() + 1;
    let mut table = vec![0_u16; (a.len() + 1) * w];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i * w + j] = if a[i] == b[j] {
                1 + table[(i + 1) * w + j + 1]
            } else {
                table[(i + 1) * w + j].max(table[i * w + j + 1])
            }
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut changes = vec![];
    let (mut old, mut new) = (vec![], vec![]);
    let flush = |old: &mut Vec<String>, new: &mut Vec<String>, changes: &mut Vec<TextChange>| {
        if !old.is_empty() || !new.is_empty() {
            let o = old.join(" ");
            let n = new.join(" ");
            let dimension_like = o
                .chars()
                .chain(n.chars())
                .any(|c| c.is_ascii_digit() || "±Ø⌀φΦ°∅".contains(c));
            changes.push(TextChange {
                old: o,
                new: n,
                dimension_like,
            });
            old.clear();
            new.clear();
        }
    };
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            flush(&mut old, &mut new, &mut changes);
            i += 1;
            j += 1;
        } else if i < a.len() && (j == b.len() || table[(i + 1) * w + j] >= table[i * w + j + 1]) {
            old.push(a[i].clone());
            i += 1
        } else {
            new.push(b[j].clone());
            j += 1
        }
        if changes.len() >= 200 {
            return TextAssistance {
                status: "limited".into(),
                changes,
                limited: true,
            };
        }
    }
    flush(&mut old, &mut new, &mut changes);
    TextAssistance {
        status: "available".into(),
        changes,
        limited: false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn symbols_and_tolerances_are_not_normalized_away() {
        let r = compare("Ø6 20.00 +0.02 ±0.02", "Ø8 20.08 -0.02 ±0.20");
        assert_eq!(r.changes.len(), 1);
        assert!(r.changes[0].old.contains("+0.02"));
        assert!(r.changes[0].new.contains("-0.02"));
        assert!(r.changes[0].dimension_like)
    }
    #[test]
    fn outlines_and_budget_have_explicit_fallback() {
        assert_eq!(compare("", "M8").status, "visual-only");
        assert!(compare(&"A ".repeat(1001), "B").limited)
    }
}
