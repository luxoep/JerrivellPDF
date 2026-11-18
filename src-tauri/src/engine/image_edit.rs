// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

fn invalid(message: &str) -> String {
    format!("ASSET_INVALID: {message}")
}
pub(super) fn validate_crop(crop: &PdfStampCrop) -> Result<(), String> {
    if [crop.x, crop.y, crop.width, crop.height]
        .iter()
        .any(|v| !v.is_finite())
        || crop.x < 0.0
        || crop.y < 0.0
        || crop.width <= 0.0
        || crop.height <= 0.0
        || crop.x + crop.width > 1.000001
        || crop.y + crop.height > 1.000001
        || (!crop.points.is_empty() && !(3..=256).contains(&crop.points.len()))
        || crop.points.iter().any(|p| {
            !p.x.is_finite()
                || !p.y.is_finite()
                || p.x < crop.x - 0.000001
                || p.y < crop.y - 0.000001
                || p.x > crop.x + crop.width + 0.000001
                || p.y > crop.y + crop.height + 0.000001
        })
    {
        return Err(invalid("裁切选区须在图像内，多边形须为 3～256 个有效点。"));
    }
    Ok(())
}

/// Even-odd scan conversion, with 2×2 coverage at edges. Work is bounded by
/// image dimensions and 256 edges, not a point-in-polygon loop for each pixel.
pub(super) fn polygon_mask(image: &mut image::RgbaImage, points: &[ImagePoint]) {
    let (width, height) = image.dimensions();
    for y in 0..height {
        let mut coverage = vec![0_u8; width as usize];
        for sy in [0.25_f32, 0.75] {
            let row = (y as f32 + sy) / height as f32;
            let mut crossings = Vec::with_capacity(points.len());
            for (a, b) in points
                .iter()
                .zip(points.iter().cycle().skip(1))
                .take(points.len())
            {
                if (a.y > row) != (b.y > row) {
                    crossings.push((a.x + (row - a.y) * (b.x - a.x) / (b.y - a.y)) * width as f32);
                }
            }
            crossings.sort_by(f32::total_cmp);
            for pair in crossings.chunks_exact(2) {
                let start = pair[0].floor().max(0.0) as u32;
                let end = pair[1].ceil().min(width as f32) as u32;
                for x in start..end {
                    for sx in [0.25_f32, 0.75] {
                        if x as f32 + sx >= pair[0] && x as f32 + sx < pair[1] {
                            coverage[x as usize] += 1;
                        }
                    }
                }
            }
        }
        for (x, count) in coverage.into_iter().enumerate() {
            let pixel = image.get_pixel_mut(x as u32, y);
            pixel.0[3] = (u16::from(pixel.0[3]) * u16::from(count) / 4) as u8;
            if pixel.0[3] == 0 {
                pixel.0 = [0, 0, 0, 0];
            }
        }
    }
}

fn erase(image: &mut image::RgbaImage, strokes: &[EraseStroke]) -> Result<(), String> {
    if strokes.len() > 64
        || strokes.iter().map(|s| s.points.len()).sum::<usize>() > 4096
        || strokes.iter().any(|s| {
            s.points.is_empty()
                || s.points.len() > 256
                || !s.width.is_finite()
                || s.width <= 0.0
                || s.width > 400.0
                || s.points.iter().any(|p| {
                    !p.x.is_finite()
                        || !p.y.is_finite()
                        || !(0.0..=1.0).contains(&p.x)
                        || !(0.0..=1.0).contains(&p.y)
                })
        })
    {
        return Err(invalid("橡皮擦参数超出范围，请分次编辑。"));
    }
    let (width, height) = image.dimensions();
    let mut budget = 0_u64;
    for stroke in strokes {
        for (a, b) in stroke
            .points
            .iter()
            .zip(stroke.points.iter().skip(1).chain(stroke.points.last()))
        {
            let (ax, ay, bx, by) = (
                a.x * width as f32,
                a.y * height as f32,
                b.x * width as f32,
                b.y * height as f32,
            );
            let radius = stroke.width / 2.0;
            let left = (ax.min(bx) - radius - 1.0).floor().max(0.0) as u32;
            let top = (ay.min(by) - radius - 1.0).floor().max(0.0) as u32;
            let right = (ax.max(bx) + radius + 1.0).ceil().min(width as f32) as u32;
            let bottom = (ay.max(by) + radius + 1.0).ceil().min(height as f32) as u32;
            budget = budget.saturating_add(u64::from(right - left) * u64::from(bottom - top));
            if budget > 128 * 1024 * 1024 {
                return Err(invalid("本次擦除计算量过大，请分次编辑。"));
            }
            let (dx, dy) = (bx - ax, by - ay);
            let length = dx * dx + dy * dy;
            for y in top..bottom {
                for x in left..right {
                    let (px, py) = (x as f32 + 0.5 - ax, y as f32 + 0.5 - ay);
                    let t = if length > 0.0 {
                        ((px * dx + py * dy) / length).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let distance = ((px - t * dx).powi(2) + (py - t * dy).powi(2)).sqrt();
                    let keep = (distance - radius + 0.5).clamp(0.0, 1.0);
                    let pixel = image.get_pixel_mut(x, y);
                    pixel.0[3] = (f32::from(pixel.0[3]) * keep).round() as u8;
                    if pixel.0[3] == 0 {
                        pixel.0 = [0, 0, 0, 0];
                    }
                }
            }
        }
    }
    Ok(())
}

impl<'a> PdfEngine<'a> {
    pub fn edit_image_asset(
        &mut self,
        asset_id: &str,
        crop: Option<&PdfStampCrop>,
        strokes: &[EraseStroke],
    ) -> Result<ImageAssetInfo, String> {
        if let Some(crop) = crop {
            validate_crop(crop)?;
        }
        let asset = self
            .assets
            .get(asset_id)
            .ok_or_else(|| invalid("图像资源已失效，请重新选择。"))?;
        let mut image = image::load_from_memory_with_format(&asset.png, ImageFormat::Png)
            .map_err(pdf_error)?
            .into_rgba8();
        if let Some(crop) = crop {
            let rectangle = vec![
                ImagePoint {
                    x: crop.x,
                    y: crop.y,
                },
                ImagePoint {
                    x: crop.x + crop.width,
                    y: crop.y,
                },
                ImagePoint {
                    x: crop.x + crop.width,
                    y: crop.y + crop.height,
                },
                ImagePoint {
                    x: crop.x,
                    y: crop.y + crop.height,
                },
            ];
            polygon_mask(
                &mut image,
                if crop.points.is_empty() {
                    &rectangle
                } else {
                    &crop.points
                },
            );
        }
        erase(&mut image, strokes)?;
        self.store_image(DynamicImage::ImageRgba8(image), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concave_mask_and_eraser_preserve_real_alpha() {
        let mut image = image::RgbaImage::from_pixel(40, 40, image::Rgba([220, 30, 50, 255]));
        let points = vec![
            ImagePoint { x: 0.0, y: 0.0 },
            ImagePoint { x: 1.0, y: 0.0 },
            ImagePoint { x: 1.0, y: 0.4 },
            ImagePoint { x: 0.4, y: 0.4 },
            ImagePoint { x: 0.4, y: 1.0 },
            ImagePoint { x: 0.0, y: 1.0 },
        ];
        polygon_mask(&mut image, &points);
        assert_eq!(image.get_pixel(30, 30).0[3], 0);
        assert_eq!(image.get_pixel(5, 30).0[3], 255);
        erase(
            &mut image,
            &[EraseStroke {
                points: vec![ImagePoint { x: 0.1, y: 0.5 }, ImagePoint { x: 0.9, y: 0.5 }],
                width: 6.0,
            }],
        )
        .unwrap();
        assert_eq!(image.get_pixel(4, 20).0[3], 0);
        assert_eq!(image.get_pixel(4, 4).0, [220, 30, 50, 255]);
        assert!(erase(
            &mut image,
            &[EraseStroke {
                points: vec![],
                width: 6.0
            }]
        )
        .is_err());
    }
}
