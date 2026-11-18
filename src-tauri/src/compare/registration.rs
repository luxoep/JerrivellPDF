// SPDX-License-Identifier: MIT OR Apache-2.0
// Bounded translation proposal. No rotation, scaling or local deformation.
use super::types::Rect;
use image::RgbaImage;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Features {
    pub width: usize,
    pub height: usize,
    pub points: Vec<(i32, i32)>,
    distance: Vec<u16>,
}
pub struct Match {
    pub x: i32,
    pub y: i32,
    pub cost: f64,
    pub agreement: f64,
    pub margin: f64,
    pub samples: usize,
}
impl Features {
    pub fn new(image: &RgbaImage, ignored: &[Rect]) -> Self {
        let (w, h) = (image.width() as usize, image.height() as usize);
        let mut distance = vec![24; w * h];
        let mut points = vec![];
        for y in 0..h {
            for x in 0..w {
                let p = image.get_pixel(x as u32, y as u32);
                let excluded = ignored.iter().any(|r| {
                    x as f64 >= r.x * w as f64
                        && y as f64 >= r.y * h as f64
                        && (x as f64) < (r.x + r.width) * w as f64
                        && (y as f64) < (r.y + r.height) * h as f64
                });
                if !excluded && (p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) < 248000
                {
                    distance[y * w + x] = 0;
                    points.push((x as i32, y as i32));
                }
            }
        }
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if x > 0 {
                    distance[i] = distance[i].min(distance[i - 1] + 1)
                }
                if y > 0 {
                    distance[i] = distance[i].min(distance[i - w] + 1)
                }
            }
        }
        for y in (0..h).rev() {
            for x in (0..w).rev() {
                let i = y * w + x;
                if x + 1 < w {
                    distance[i] = distance[i].min(distance[i + 1] + 1)
                }
                if y + 1 < h {
                    distance[i] = distance[i].min(distance[i + w] + 1)
                }
            }
        }
        let step = points.len().div_ceil(2400).max(1);
        points = points.into_iter().step_by(step).collect();
        Self {
            width: w,
            height: h,
            points,
            distance,
        }
    }
    pub fn informative(&self) -> bool {
        if self.points.len() < 40 {
            return false;
        }
        let (minx, maxx, miny, maxy) = self
            .points
            .iter()
            .fold((i32::MAX, 0, i32::MAX, 0), |(a, b, c, d), &(x, y)| {
                (a.min(x), b.max(x), c.min(y), d.max(y))
            });
        maxx - minx >= 12
            && maxy - miny >= 12
            && self.distance.iter().filter(|&&v| v == 0).count() * 2 < self.width * self.height
    }
    fn at(&self, x: i32, y: i32) -> u16 {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            12
        } else {
            self.distance[y as usize * self.width + x as usize].min(12)
        }
    }
}
pub fn pooled(image: &RgbaImage, long: u32) -> RgbaImage {
    let scale = long as f64 / image.width().max(image.height()) as f64;
    let (w, h) = (
        (image.width() as f64 * scale).round().max(1.) as u32,
        (image.height() as f64 * scale).round().max(1.) as u32,
    );
    let mut out = RgbaImage::from_pixel(w, h, image::Rgba([255; 4]));
    for (x, y, p) in image.enumerate_pixels() {
        if (p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) < 248000 {
            out.put_pixel(
                (x as u64 * w as u64 / image.width() as u64).min(w as u64 - 1) as u32,
                (y as u64 * h as u64 / image.height() as u64).min(h as u64 - 1) as u32,
                image::Rgba([0, 0, 0, 255]),
            );
        }
    }
    out
}
fn score(a: &Features, b: &Features, x: i32, y: i32) -> (f64, f64) {
    let mut cost = 0_u64;
    let mut good = 0;
    for &(px, py) in &a.points {
        let d = b.at(px - x, py - y);
        cost += (d.min(8) * d.min(8)) as u64;
        if d <= 1 {
            good += 1
        }
    }
    for &(px, py) in &b.points {
        let d = a.at(px + x, py + y);
        cost += (d.min(8) * d.min(8)) as u64;
        if d <= 1 {
            good += 1
        }
    }
    let n = (a.points.len() + b.points.len()).max(1) as f64;
    (cost as f64 / n, good as f64 / n)
}
pub fn search(
    a: &Features,
    b: &Features,
    center: [i32; 2],
    radius: [i32; 2],
    step: i32,
    token: &AtomicBool,
) -> Result<Match, String> {
    search_sets(
        std::slice::from_ref(a),
        std::slice::from_ref(b),
        center,
        radius,
        step,
        token,
    )
}
pub fn search_sets(
    a: &[Features],
    b: &[Features],
    center: [i32; 2],
    radius: [i32; 2],
    step: i32,
    token: &AtomicBool,
) -> Result<Match, String> {
    let mut candidates = vec![];
    for y in ((center[1] - radius[1])..=(center[1] + radius[1])).step_by(step as usize) {
        if token.load(Ordering::Acquire) {
            return Err("COMPARE_CANCELLED".into());
        }
        for x in ((center[0] - radius[0])..=(center[0] + radius[0])).step_by(step as usize) {
            let mut cost = 0.;
            let mut agreement = 0.;
            let mut n = 0.;
            for (af, bf) in a.iter().zip(b) {
                let count = (af.points.len() + bf.points.len()) as f64;
                let (c, g) = score(af, bf, x, y);
                cost += c * count;
                agreement += g * count;
                n += count
            }
            candidates.push((cost / n.max(1.), x, y, agreement / n.max(1.)));
        }
    }
    candidates.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then_with(|| (a.1.abs() + a.2.abs()).cmp(&(b.1.abs() + b.2.abs())))
    });
    let &(cost, x, y, agreement) = candidates.first().ok_or("配准搜索范围无效。")?;
    let second = candidates
        .iter()
        .find(|v| (v.1 - x).abs() > step * 2 || (v.2 - y).abs() > step * 2)
        .map_or(64.0, |v| v.0);
    Ok(Match {
        x,
        y,
        cost,
        agreement,
        margin: (second - cost).max(0.0) / (second + 1.0),
        samples: a.iter().map(|v| v.points.len()).sum::<usize>()
            + b.iter().map(|v| v.points.len()).sum::<usize>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    fn drawing(dx: i32, dy: i32) -> RgbaImage {
        let mut im = RgbaImage::from_pixel(192, 160, Rgba([255; 4]));
        for y in 15..140 {
            for x in 20..165 {
                if x == 20
                    || y == 15
                    || x == 164
                    || y == 139
                    || (x == 63 && y < 95)
                    || (y == 72 && x > 90)
                {
                    let (px, py) = (x + dx, y + dy);
                    if px >= 0 && py >= 0 && px < 192 && py < 160 {
                        im.put_pixel(px as u32, py as u32, Rgba([0, 0, 0, 255]));
                    }
                }
            }
        }
        im
    }
    #[test]
    fn translation_sign_and_blank_rejection() {
        let t = AtomicBool::new(false);
        let a = Features::new(&drawing(0, 0), &[]);
        let b = Features::new(&drawing(8, -6), &[]);
        let m = search(&a, &b, [0, 0], [16, 16], 1, &t).unwrap();
        assert_eq!((m.x, m.y), (-8, 6));
        assert_eq!(m.cost, 0.0);
        assert!(m.agreement > 0.99);
        assert!(m.margin > 0.1);
        assert!(!Features::new(&RgbaImage::from_pixel(80, 80, Rgba([255; 4])), &[]).informative());
    }
    #[test]
    fn cancelled_search_never_yields_proposal() {
        let a = Features::new(&drawing(0, 0), &[]);
        assert!(search(&a, &a, [0, 0], [30, 30], 1, &AtomicBool::new(true)).is_err())
    }
}
