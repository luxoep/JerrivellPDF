// SPDX-License-Identifier: MIT OR Apache-2.0
// Small original bitmap labels for reports. No font program is embedded.
use super::types::{Report, ScaleMode};
use image::{Rgba, RgbaImage};

fn glyph(c: char) -> [u8; 7] {
    match c {
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '6' => [14, 16, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'J' => [7, 2, 2, 2, 2, 18, 12],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 25, 25, 21, 19, 19, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'Q' => [14, 17, 17, 17, 21, 18, 13],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'W' => [17, 17, 17, 21, 21, 27, 17],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 10, 4, 4, 4, 4],
        'Z' => [31, 1, 2, 4, 8, 16, 31],
        '-' => [0, 0, 0, 31, 0, 0, 0],
        '.' => [0, 0, 0, 0, 0, 6, 6],
        ':' => [0, 4, 4, 0, 4, 4, 0],
        '/' => [1, 1, 2, 4, 8, 16, 16],
        _ => [0; 7],
    }
}
fn text(image: &mut RgbaImage, value: &str, x: u32, y: u32, color: Rgba<u8>, scale: u32) {
    for (index, c) in value.chars().enumerate() {
        for (row, bits) in glyph(c).iter().enumerate() {
            for col in 0..5 {
                if bits & (1 << (4 - col)) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let px = x + index as u32 * 6 * scale + col * scale + dx;
                            let py = y + row as u32 * scale + dy;
                            if px < image.width() && py < image.height() {
                                image.put_pixel(px, py, color);
                            }
                        }
                    }
                }
            }
        }
    }
}
pub fn label(mut image: RgbaImage, report: &Report, scale_b: f64) -> RgbaImage {
    let blue = Rgba([40, 75, 94, 255]);
    for region in &report.regions {
        let b = region.bounds;
        let value = region.id.to_string();
        let width = value.len() as u32 * 12 + 6;
        let x = ((b.x * image.width() as f64) as u32).min(image.width().saturating_sub(width));
        let y = ((b.y * image.height() as f64) as u32)
            .saturating_sub(20)
            .min(image.height().saturating_sub(20));
        for py in y..(y + 20).min(image.height()) {
            for px in x..(x + width).min(image.width()) {
                image.put_pixel(px, py, blue);
            }
        }
        text(
            &mut image,
            &value,
            x + 3,
            y + 3,
            Rgba([255, 255, 255, 255]),
            2,
        );
    }
    let height = image.height();
    let mut result = RgbaImage::from_pixel(image.width(), height + 82, Rgba([255, 253, 246, 255]));
    image::imageops::replace(&mut result, &image, 0, 0);
    text(
        &mut result,
        &format!(
            "JERRIVELL COMPARE  DPI {}  TOL {}  PAGES {}/{}  REGIONS {}",
            report.options.dpi,
            report.options.threshold,
            report.options.page_a + 1,
            report.options.page_b + 1,
            report.regions.len()
        ),
        12,
        height + 9,
        blue,
        2,
    );
    for (label, x, color) in [
        ("ADDED", 12, Rgba([20, 143, 74, 255])),
        ("REMOVED", 108, Rgba([190, 27, 111, 255])),
        ("COLOR", 228, Rgba([180, 105, 15, 255])),
        ("GRAY HATCH - IGNORED", 320, Rgba([100, 111, 124, 255])),
    ] {
        text(&mut result, label, x, height + 33, color, 2);
    }
    let normalized_note = format!(
        "NORMALIZED TO A - B SCALE {:.5} - REFERENCE UNITS - {}",
        scale_b,
        if report.uncovered || report.ignored_pixels > 0 {
            "QUALIFIED COVERAGE / EXCLUSIONS"
        } else {
            "REVIEW ORIGINALS"
        }
    );
    let note = if report.options.scale_mode == ScaleMode::Normalized {
        normalized_note.as_str()
    } else if report.uncovered || report.ignored_pixels > 0 {
        "QUALIFIED COVERAGE - CHECK EXCLUDED AREAS AND ORIGINALS - IDS MATCH CSV"
    } else {
        "PIXEL RESULT - REVIEW ORIGINAL DRAWINGS - IDS MATCH CSV"
    };
    text(&mut result, note, 12, height + 57, blue, 2);
    result
}
