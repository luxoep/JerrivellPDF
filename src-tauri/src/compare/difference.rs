// SPDX-License-Identifier: MIT OR Apache-2.0
//! Streaming run components. No area filter: a single changed pixel survives.
use super::types::{Rect, Region};
use image::{Rgba, RgbaImage};

#[derive(Clone, Debug)]
pub struct Run {
    pub x: u32,
    pub end: u32,
    pub y: u32,
    pub kind: u8,
    pub node: usize,
}
#[derive(Clone)]
struct Node {
    parent: usize,
    min_x: u32,
    min_y: u32,
    max_x: u32,
    max_y: u32,
    pixels: u64,
    counts: [u64; 3],
    point: [u32; 2],
}
pub struct Components {
    nodes: Vec<Node>,
    previous: Vec<Run>,
    pub runs: Vec<Run>,
}
impl Components {
    pub fn new() -> Self {
        Self {
            nodes: vec![],
            previous: vec![],
            runs: vec![],
        }
    }
    fn root(&mut self, mut i: usize) -> usize {
        while self.nodes[i].parent != i {
            let p = self.nodes[i].parent;
            self.nodes[i].parent = self.nodes[p].parent;
            i = self.nodes[i].parent;
        }
        i
    }
    fn union(&mut self, a: usize, b: usize) {
        let a = self.root(a);
        let b = self.root(b);
        if a == b {
            return;
        }
        let (a, b) = if a < b { (a, b) } else { (b, a) };
        let n = self.nodes[b].clone();
        let p = &mut self.nodes[a];
        p.min_x = p.min_x.min(n.min_x);
        p.min_y = p.min_y.min(n.min_y);
        p.max_x = p.max_x.max(n.max_x);
        p.max_y = p.max_y.max(n.max_y);
        p.pixels += n.pixels;
        for i in 0..3 {
            p.counts[i] += n.counts[i]
        }
        self.nodes[b].parent = a;
    }
    pub fn row(&mut self, mut current: Vec<Run>) -> Result<(), String> {
        if self.runs.len() + current.len() > 500_000 {
            return Err("差异过于复杂，已停止完整性计算；请确认对齐或缩小比较范围。".into());
        }
        let mut previous_cursor = 0;
        for run in &mut current {
            let n = self.nodes.len();
            let mut counts = [0; 3];
            counts[(run.kind - 1) as usize] = (run.end - run.x) as u64;
            self.nodes.push(Node {
                parent: n,
                min_x: run.x,
                min_y: run.y,
                max_x: run.end,
                max_y: run.y + 1,
                pixels: (run.end - run.x) as u64,
                counts,
                point: [run.x, run.y],
            });
            run.node = n;
            while previous_cursor < self.previous.len()
                && self.previous[previous_cursor].end < run.x
            {
                previous_cursor += 1
            }
            let mut j = previous_cursor;
            while j < self.previous.len() && self.previous[j].x <= run.end {
                if self.previous[j].y + 1 == run.y {
                    self.union(n, self.previous[j].node);
                }
                j += 1;
            }
        }
        for pair in current.windows(2) {
            if pair[0].end == pair[1].x {
                self.union(pair[0].node, pair[1].node)
            }
        }
        self.runs.extend(current.iter().cloned());
        self.previous = current;
        Ok(())
    }
    pub fn regions(&mut self, width: u32, height: u32) -> Result<Vec<Region>, String> {
        // Small neighbouring components are grouped for navigation only. Runs stay exact.
        let roots: Vec<usize> = (0..self.nodes.len())
            .filter(|&i| self.nodes[i].parent == i)
            .collect();
        if roots.len() > 40_000 {
            return Err(
                "差异点超过首版处理上限；结果未完成。请检查对齐、容差或选用局部图纸。".into(),
            );
        }
        let mut sorted = roots;
        sorted.sort_by_key(|&i| self.nodes[i].min_y);
        let gap = 3_u32;
        let mut comparisons = 0;
        for (pos, &i) in sorted.iter().enumerate() {
            for &j in sorted.iter().skip(pos + 1) {
                if self.nodes[j].min_y > self.nodes[i].max_y.saturating_add(gap) {
                    break;
                }
                comparisons += 1;
                if comparisons > 8_000_000 {
                    return Err("差异分组超过资源预算；未生成完整结论。".into());
                }
                if self.nodes[j].min_x <= self.nodes[i].max_x.saturating_add(gap)
                    && self.nodes[j].max_x.saturating_add(gap) >= self.nodes[i].min_x
                {
                    self.union(i, j)
                }
            }
        }
        let mut result = Vec::new();
        for i in 0..self.nodes.len() {
            if self.nodes[i].parent != i {
                continue;
            }
            let n = &self.nodes[i];
            result.push(Region {
                id: 0,
                bounds: Rect {
                    x: n.min_x as f64 / width as f64,
                    y: n.min_y as f64 / height as f64,
                    width: (n.max_x - n.min_x) as f64 / width as f64,
                    height: (n.max_y - n.min_y) as f64 / height as f64,
                },
                pixels: n.pixels,
                removed: n.counts[0],
                added: n.counts[1],
                changed: n.counts[2],
                point: [
                    n.point[0] as f64 / width as f64,
                    n.point[1] as f64 / height as f64,
                ],
            })
        }
        if result.len() > 5000 {
            return Err("差异区域超过 5000 个，未生成完整结论；请先检查对齐。".into());
        }
        result.sort_by(|a, b| {
            a.bounds
                .y
                .total_cmp(&b.bounds.y)
                .then(a.bounds.x.total_cmp(&b.bounds.x))
        });
        for (i, r) in result.iter_mut().enumerate() {
            r.id = (i + 1) as u32
        }
        Ok(result)
    }
}
pub fn classify(a: &[u8], b: &[u8], threshold: u8) -> u8 {
    if (0..3).map(|c| a[c].abs_diff(b[c])).max().unwrap_or(0) <= threshold {
        return 0;
    }
    let la = (a[0] as u32 * 299 + a[1] as u32 * 587 + a[2] as u32 * 114) / 1000;
    let lb = (b[0] as u32 * 299 + b[1] as u32 * 587 + b[2] as u32 * 114) / 1000;
    if la > lb + 8 {
        2
    } else if lb > la + 8 {
        1
    } else {
        3
    }
}
pub fn color(kind: u8) -> Rgba<u8> {
    match kind {
        1 => Rgba([210, 37, 121, 220]),
        2 => Rgba([20, 163, 84, 220]),
        _ => Rgba([239, 140, 24, 220]),
    }
}
pub fn paint_runs(image: &mut RgbaImage, runs: &[Run], width: u32, height: u32) {
    let w = image.width();
    let h = image.height();
    for r in runs {
        let y = (r.y as u64 * h as u64 / height as u64).min(h as u64 - 1) as u32;
        let from = (r.x as u64 * w as u64 / width as u64).min(w as u64 - 1) as u32;
        let end = (r.end as u64 * w as u64)
            .div_ceil(width as u64)
            .min(w as u64) as u32;
        for x in from..end.max(from + 1) {
            image.put_pixel(x, y, color(r.kind));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiny_and_seam_components_survive() {
        let mut c = Components::new();
        c.row(vec![
            Run {
                x: 1023,
                end: 1024,
                y: 0,
                kind: 1,
                node: 0,
            },
            Run {
                x: 1024,
                end: 1025,
                y: 0,
                kind: 2,
                node: 0,
            },
        ])
        .unwrap();
        c.row(vec![Run {
            x: 1024,
            end: 1025,
            y: 1,
            kind: 2,
            node: 0,
        }])
        .unwrap();
        c.row(vec![]).unwrap();
        c.row(vec![Run {
            x: 30,
            end: 31,
            y: 3,
            kind: 3,
            node: 0,
        }])
        .unwrap();
        let r = c.regions(2048, 1024).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r.iter().map(|v| v.pixels).sum::<u64>(), 4);
        assert!(r.iter().any(|v| v.pixels == 1));
        assert!(r.iter().any(|v| v.added == 2 && v.removed == 1));
    }
    #[test]
    fn colors_and_threshold() {
        assert_eq!(classify(&[255, 255, 255], &[0, 0, 0], 0), 2);
        assert_eq!(classify(&[0, 0, 0], &[255, 255, 255], 0), 1);
        assert_eq!(classify(&[255, 255, 255], &[254, 255, 255], 0), 3);
        assert_eq!(classify(&[255, 255, 255], &[254, 255, 255], 1), 0);
    }
}
