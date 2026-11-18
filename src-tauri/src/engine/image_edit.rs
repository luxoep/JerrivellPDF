// SPDX-License-Identifier: MIT OR Apache-2.0
use super::*;

fn invalid(message: &str) -> String {
    format!("ASSET_INVALID: {message}")
}
fn validate_region(crop: &PdfStampCrop) -> Result<(), String> {
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
pub(super) fn validate_crop(crop: &PdfStampCrop) -> Result<(), String> {
    validate_region(crop)?;
    if crop.regions.len() > 16 || (!crop.regions.is_empty() && !crop.points.is_empty()) {
        return Err(invalid(
            "最多保留 16 个独立选区，不能混合父级轮廓或嵌套选区。",
        ));
    }
    for region in &crop.regions {
        validate_region(region)?;
        if !region.regions.is_empty()
            || region.x < crop.x - 0.000001
            || region.y < crop.y - 0.000001
            || region.x + region.width > crop.x + crop.width + 0.000001
            || region.y + region.height > crop.y + crop.height + 0.000001
        {
            return Err(invalid("独立选区必须位于总选框内，且不能嵌套。"));
        }
    }
    Ok(())
}
fn outline(crop: &PdfStampCrop) -> Vec<ImagePoint> {
    if !crop.points.is_empty() {
        return crop.points.clone();
    }
    vec![
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
    ]
}

/// OR four subpixel coverage bits across all regions before counting coverage;
/// overlaps neither punch holes nor multiply edge transparency.
fn union_mask(image: &mut image::RgbaImage, outlines: &[Vec<ImagePoint>]) {
    let (width, height) = image.dimensions();
    let mut coverage = vec![0_u8; width as usize];
    let mut crossings = Vec::with_capacity(256);
    let mut intervals = Vec::with_capacity(256);
    for y in 0..height {
        coverage.fill(0);
        for (iy, sy) in [0.25_f32, 0.75].into_iter().enumerate() {
            let row = (y as f32 + sy) / height as f32;
            intervals.clear();
            for points in outlines {
                crossings.clear();
                for (a, b) in points
                    .iter()
                    .zip(points.iter().cycle().skip(1))
                    .take(points.len())
                {
                    if (a.y > row) != (b.y > row) {
                        crossings
                            .push((a.x + (row - a.y) * (b.x - a.x) / (b.y - a.y)) * width as f32);
                    }
                }
                crossings.sort_by(f32::total_cmp);
                for pair in crossings.chunks_exact(2) {
                    intervals.push((pair[0], pair[1]));
                }
            }
            // Merge before touching pixels: 16 overlapping full-page regions
            // cost one fill per subpixel row, not 16 full-image fills.
            intervals.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
            let mut merged: Option<(f32, f32)> = None;
            let fill = |span: (f32, f32), coverage: &mut [u8]| {
                let start = span.0.floor().max(0.0) as u32;
                let end = span.1.ceil().min(width as f32) as u32;
                for x in start..end {
                    for (ix, sx) in [0.25_f32, 0.75].into_iter().enumerate() {
                        if x as f32 + sx >= span.0 && x as f32 + sx < span.1 {
                            coverage[x as usize] |= 1 << (iy * 2 + ix);
                        }
                    }
                }
            };
            for &(left, right) in &intervals {
                if let Some((start, end)) = merged {
                    if left <= end {
                        merged = Some((start, end.max(right)));
                    } else {
                        fill((start, end), &mut coverage);
                        merged = Some((left, right));
                    }
                } else {
                    merged = Some((left, right));
                }
            }
            if let Some(span) = merged {
                fill(span, &mut coverage);
            }
        }
        for (x, bits) in coverage.iter().enumerate() {
            let pixel = image.get_pixel_mut(x as u32, y);
            pixel.0[3] = (u16::from(pixel.0[3]) * bits.count_ones() as u16 / 4) as u8;
            if pixel.0[3] == 0 {
                pixel.0 = [0, 0, 0, 0];
            }
        }
    }
}
pub(super) fn crop_mask(image: &mut image::RgbaImage, crop: &PdfStampCrop) {
    let outlines: Vec<_> = if crop.regions.is_empty() {
        vec![outline(crop)]
    } else {
        crop.regions.iter().map(outline).collect()
    };
    union_mask(image, &outlines);
}
#[cfg(test)]
fn polygon_mask(image: &mut image::RgbaImage, points: &[ImagePoint]) {
    union_mask(image, &[points.to_vec()]);
}

fn stroke_masks(
    image: &image::RgbaImage,
    strokes: &[EraseStroke],
) -> Result<(Vec<u8>, Vec<u8>), String> {
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
    let mut transparent = vec![0_u8; (width as usize) * (height as usize)];
    let mut repair = vec![0_u8; transparent.len()];
    let mut budget = 0_u64;
    for stroke in strokes {
        let mask = if stroke.mode == EraseMode::Repair {
            &mut repair
        } else {
            &mut transparent
        };
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
                    let coverage =
                        ((radius + 0.5 - distance).clamp(0.0, 1.0) * 255.0).round() as u8;
                    let index = (y as usize) * (width as usize) + x as usize;
                    mask[index] = mask[index].max(coverage);
                }
            }
        }
    }
    Ok((transparent, repair))
}

/// Only pixels outside ALL erase strokes are donors. Filled pixels never
/// contaminate subsequent strokes. Median rejects isolated text at boundaries.
fn background_sample(
    image: &image::RgbaImage,
    blocked: &[bool],
    x: i32,
    y: i32,
) -> Option<[u8; 3]> {
    if x < 0 || y < 0 || x >= image.width() as i32 || y >= image.height() as i32 {
        return None;
    }
    let mut channels: [Vec<u8>; 3] = std::array::from_fn(|_| Vec::with_capacity(25));
    for sy in (y - 2).max(0)..=(y + 2).min(image.height() as i32 - 1) {
        for sx in (x - 2).max(0)..=(x + 2).min(image.width() as i32 - 1) {
            let p = image.get_pixel(sx as u32, sy as u32);
            if !blocked[sy as usize * image.width() as usize + sx as usize] && p.0[3] > 0 {
                for (c, values) in channels.iter_mut().enumerate() {
                    values.push(p.0[c]);
                }
            }
        }
    }
    if channels[0].is_empty() {
        return None;
    }
    Some(std::array::from_fn(|c| {
        channels[c].sort_unstable();
        channels[c][channels[c].len() / 2]
    }))
}
fn interpolate(a: Option<[u8; 3]>, b: Option<[u8; 3]>, t: f32) -> Option<[u8; 3]> {
    match (a, b) {
        (Some(a), Some(b)) => Some(std::array::from_fn(|c| {
            (f32::from(a[c]) * (1.0 - t) + f32::from(b[c]) * t).round() as u8
        })),
        (Some(a), None) | (None, Some(a)) => Some(a),
        _ => None,
    }
}

/// Local repair for flat/smooth backgrounds: robust row/column boundary
/// interpolation weighted towards the shorter crossing. O(pixels + bounded
/// boundary samples), no model, external service or invented alpha.
fn repair_background(
    image: &mut image::RgbaImage,
    repair: &[u8],
    transparent: &[u8],
) -> Result<(), String> {
    if !repair.iter().any(|v| *v > 0) {
        return Ok(());
    }
    let (width, height) = (image.width() as usize, image.height() as usize);
    let blocked: Vec<bool> = repair
        .iter()
        .zip(transparent)
        .map(|(a, b)| *a > 0 || *b > 0)
        .collect();
    let mut spans = vec![0_u16; repair.len()];
    let partial: Vec<_> = repair
        .iter()
        .enumerate()
        .filter(|(_, a)| **a > 0 && **a < 255)
        .map(|(i, _)| (i, image.get_pixel((i % width) as u32, (i / width) as u32).0))
        .collect();
    for y in 0..height {
        let mut x = 0;
        while x < width {
            if !blocked[y * width + x] {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && blocked[y * width + x] {
                x += 1;
            }
            let end = x;
            let a = background_sample(image, &blocked, start as i32 - 1, y as i32);
            let b = background_sample(image, &blocked, end as i32, y as i32);
            for px in start..end {
                let index = y * width + px;
                if repair[index] == 0 {
                    continue;
                }
                if let Some(color) =
                    interpolate(a, b, (px - start + 1) as f32 / (end - start + 1) as f32)
                {
                    let pixel = image.get_pixel_mut(px as u32, y as u32);
                    if pixel.0[3] > 0 {
                        pixel.0[..3].copy_from_slice(&color);
                        spans[index] = (end - start + 1) as u16;
                    }
                }
            }
        }
    }
    for x in 0..width {
        let mut y = 0;
        while y < height {
            if !blocked[y * width + x] {
                y += 1;
                continue;
            }
            let start = y;
            while y < height && blocked[y * width + x] {
                y += 1;
            }
            let end = y;
            let a = background_sample(image, &blocked, x as i32, start as i32 - 1);
            let b = background_sample(image, &blocked, x as i32, end as i32);
            for py in start..end {
                let index = py * width + x;
                if repair[index] == 0 {
                    continue;
                }
                if let Some(color) =
                    interpolate(a, b, (py - start + 1) as f32 / (end - start + 1) as f32)
                {
                    let pixel = image.get_pixel_mut(x as u32, py as u32);
                    if pixel.0[3] == 0 {
                        continue;
                    }
                    let horizontal = f32::from(spans[index]);
                    let vertical = (end - start + 1) as f32;
                    for (c, value) in color.into_iter().enumerate() {
                        pixel.0[c] = if horizontal == 0.0 {
                            value
                        } else {
                            ((f32::from(pixel.0[c]) * vertical + f32::from(value) * horizontal)
                                / (horizontal + vertical))
                                .round() as u8
                        };
                    }
                    spans[index] = 1;
                }
            }
        }
    }
    for (i, coverage) in repair.iter().enumerate() {
        if *coverage > 0
            && spans[i] == 0
            && image.get_pixel((i % width) as u32, (i / width) as u32).0[3] > 0
        {
            return Err(invalid(
                "选区周围没有可用于修复的背景，请缩小笔刷或改用透明擦除。",
            ));
        }
    }
    for (i, original) in partial {
        let pixel = image.get_pixel_mut((i % width) as u32, (i / width) as u32);
        let t = f32::from(repair[i]) / 255.0;
        for (c, value) in original.iter().enumerate().take(3) {
            pixel.0[c] = (f32::from(*value) * (1.0 - t) + f32::from(pixel.0[c]) * t).round() as u8;
        }
    }
    Ok(())
}
fn erase(image: &mut image::RgbaImage, strokes: &[EraseStroke]) -> Result<(), String> {
    if strokes.is_empty() {
        return Ok(());
    }
    let (transparent, repair) = stroke_masks(image, strokes)?;
    repair_background(image, &repair, &transparent)?;
    for (pixel, coverage) in image.pixels_mut().zip(transparent) {
        if coverage > 0 {
            pixel.0[3] = (u16::from(pixel.0[3]) * (255 - u16::from(coverage)) / 255) as u8;
            if pixel.0[3] == 0 {
                pixel.0 = [0, 0, 0, 0];
            }
        }
    }
    Ok(())
}
impl<'a> PdfEngine<'a> {
    fn edited_image(
        &self,
        asset_id: &str,
        crop: Option<&PdfStampCrop>,
        strokes: &[EraseStroke],
    ) -> Result<image::RgbaImage, String> {
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
        erase(&mut image, strokes)?;
        // Repair donors come from the original full image. Selection changes
        // only control the final visible union, never the background estimate.
        if let Some(crop) = crop {
            crop_mask(&mut image, crop);
        }
        Ok(image)
    }
    pub fn edit_image_asset(
        &mut self,
        asset_id: &str,
        crop: Option<&PdfStampCrop>,
        strokes: &[EraseStroke],
    ) -> Result<ImageAssetInfo, String> {
        let image = self.edited_image(asset_id, crop, strokes)?;
        self.store_image(DynamicImage::ImageRgba8(image), None)
    }
    pub fn preview_image_edit(
        &self,
        asset_id: &str,
        crop: Option<&PdfStampCrop>,
        strokes: &[EraseStroke],
    ) -> Result<Value, String> {
        let image = self.edited_image(asset_id, crop, strokes)?;
        let (width, height) = image.dimensions();
        let image = DynamicImage::ImageRgba8(image);
        let image = if width > 1000 || height > 1000 {
            image.thumbnail(1000, 1000)
        } else {
            image
        };
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, ImageFormat::Png)
            .map_err(pdf_error)?;
        Ok(
            json!({"dataUrl":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png.into_inner())),"width":width,"height":height}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rectangle(x: f32, y: f32, width: f32, height: f32) -> PdfStampCrop {
        PdfStampCrop {
            x,
            y,
            width,
            height,
            points: vec![],
            regions: vec![],
        }
    }
    fn stroke(mode: EraseMode, points: Vec<ImagePoint>, width: f32) -> EraseStroke {
        EraseStroke {
            mode,
            points,
            width,
        }
    }
    #[test]
    fn concave_mask_and_eraser_preserve_real_alpha() {
        let mut image = image::RgbaImage::from_pixel(40, 40, image::Rgba([220, 30, 50, 255]));
        polygon_mask(
            &mut image,
            &[
                ImagePoint { x: 0.0, y: 0.0 },
                ImagePoint { x: 1.0, y: 0.0 },
                ImagePoint { x: 1.0, y: 0.4 },
                ImagePoint { x: 0.4, y: 0.4 },
                ImagePoint { x: 0.4, y: 1.0 },
                ImagePoint { x: 0.0, y: 1.0 },
            ],
        );
        assert_eq!(image.get_pixel(30, 30).0[3], 0);
        assert_eq!(image.get_pixel(5, 30).0[3], 255);
        erase(
            &mut image,
            &[stroke(
                EraseMode::Transparent,
                vec![ImagePoint { x: 0.1, y: 0.5 }, ImagePoint { x: 0.9, y: 0.5 }],
                6.0,
            )],
        )
        .unwrap();
        assert_eq!(image.get_pixel(4, 20).0[3], 0);
        assert_eq!(image.get_pixel(4, 4).0, [220, 30, 50, 255]);
        assert!(erase(&mut image, &[stroke(EraseMode::Transparent, vec![], 6.0)]).is_err());
    }
    #[test]
    fn disconnected_and_overlapping_regions_form_a_union() {
        let mut crop = rectangle(0.05, 0.1, 0.9, 0.8);
        crop.regions = vec![
            rectangle(0.05, 0.1, 0.25, 0.3),
            rectangle(0.7, 0.6, 0.25, 0.3),
            rectangle(0.1, 0.2, 0.2, 0.2),
        ];
        validate_crop(&crop).unwrap();
        let mut image = image::RgbaImage::from_pixel(100, 100, image::Rgba([30, 60, 90, 128]));
        crop_mask(&mut image, &crop);
        assert_eq!(image.get_pixel(10, 15).0[3], 128);
        assert_eq!(image.get_pixel(20, 30).0[3], 128);
        assert_eq!(image.get_pixel(80, 75).0[3], 128);
        assert_eq!(image.get_pixel(50, 50).0[3], 0);
        let mut duplicate = crop.clone();
        duplicate.regions.push(crop.regions[0].clone());
        let mut second = image::RgbaImage::from_pixel(100, 100, image::Rgba([30, 60, 90, 128]));
        crop_mask(&mut second, &duplicate);
        assert_eq!(second, image);
        crop.regions[0].regions.push(rectangle(0.05, 0.1, 0.1, 0.1));
        assert!(validate_crop(&crop).is_err());
        crop.regions = vec![rectangle(0.1, 0.1, 0.1, 0.1); 17];
        assert!(validate_crop(&crop).is_err());
    }
    #[test]
    fn repair_removes_ink_on_a_gradient_and_retains_alpha_and_outside_pixels() {
        let mut image = image::RgbaImage::from_fn(120, 80, |x, y| {
            image::Rgba([170 + x as u8 / 3, 190 + y as u8 / 4, 215, 180])
        });
        let original = image.clone();
        for y in 30..50 {
            for x in 38..82 {
                image.put_pixel(x, y, image::Rgba([5, 8, 10, 180]));
            }
        }
        let outside = image.get_pixel(10, 10).0;
        erase(
            &mut image,
            &[stroke(
                EraseMode::Repair,
                vec![
                    ImagePoint { x: 0.32, y: 0.5 },
                    ImagePoint { x: 0.68, y: 0.5 },
                ],
                26.0,
            )],
        )
        .unwrap();
        assert_eq!(image.get_pixel(10, 10).0, outside);
        for (x, y, p) in image.enumerate_pixels() {
            assert_eq!(p.0[3], 180);
            if (45..75).contains(&x) && (33..47).contains(&y) {
                for c in 0..3 {
                    assert!(
                        p.0[c].abs_diff(original.get_pixel(x, y).0[c]) <= 3,
                        "{x},{y}: {:?}",
                        p.0
                    );
                }
            }
        }
    }
    #[test]
    fn repair_strokes_share_uncontaminated_donors_and_never_fill_original_transparency() {
        let mut image = image::RgbaImage::from_pixel(80, 80, image::Rgba([225, 210, 180, 255]));
        for y in 25..55 {
            for x in 20..60 {
                image.put_pixel(x, y, image::Rgba([8, 8, 8, 255]));
            }
        }
        image.put_pixel(40, 40, image::Rgba([0, 0, 0, 0]));
        let a = stroke(
            EraseMode::Repair,
            vec![ImagePoint { x: 0.3, y: 0.5 }, ImagePoint { x: 0.5, y: 0.5 }],
            36.0,
        );
        let b = stroke(
            EraseMode::Repair,
            vec![ImagePoint { x: 0.5, y: 0.5 }, ImagePoint { x: 0.7, y: 0.5 }],
            36.0,
        );
        let mut reordered = image.clone();
        erase(&mut image, &[a.clone(), b.clone()]).unwrap();
        erase(&mut reordered, &[b, a]).unwrap();
        assert_eq!(image, reordered);
        assert_eq!(image.get_pixel(30, 40).0, [225, 210, 180, 255]);
        assert_eq!(image.get_pixel(40, 40).0[3], 0);
        let mut tiny = image::RgbaImage::from_pixel(2, 2, image::Rgba([20, 30, 40, 255]));
        assert!(erase(
            &mut tiny,
            &[stroke(
                EraseMode::Repair,
                vec![ImagePoint { x: 0.5, y: 0.5 }],
                100.0
            )]
        )
        .is_err());
    }
    #[test]
    fn legacy_erase_json_stays_transparent_and_unknown_modes_are_rejected() {
        let s: EraseStroke =
            serde_json::from_value(json!({"points":[{"x":0.5,"y":0.5}],"width":5})).unwrap();
        assert_eq!(s.mode, EraseMode::Transparent);
        assert!(
            serde_json::from_value::<EraseStroke>(json!({"points":[],"width":5,"mode":"ai"}))
                .is_err()
        );
    }
}
