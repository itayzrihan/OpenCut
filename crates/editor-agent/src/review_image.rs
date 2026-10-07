//! Pixel facts from the exact sampled artifact, never model self-attestation.
use crate::AgentError;
use jpeg_decoder::{Decoder, PixelFormat};
use serde_json::{Value, json};
use std::io::Cursor;

pub(crate) fn inspect_jpeg(bytes: &[u8]) -> Result<Value, AgentError> {
    let invalid = |reason: &str| AgentError::Invalid(format!("Invalid review JPEG: {reason}"));
    if bytes.is_empty() || bytes.len() > 250_000 {
        return Err(invalid("encoded size exceeds 250000 bytes"));
    }
    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.set_max_decoding_buffer_size(4 * 1024 * 1024);
    decoder
        .read_info()
        .map_err(|_| invalid("header decode failed"))?;
    let info = decoder
        .info()
        .ok_or_else(|| invalid("missing dimensions"))?;
    if info.width == 0 || info.height == 0 || info.width > 1024 || info.height > 1024 {
        return Err(invalid("dimensions exceed 1024x1024"));
    }
    let channels = match info.pixel_format {
        PixelFormat::L8 => 1,
        PixelFormat::RGB24 => 3,
        _ => return Err(invalid("requires 8-bit gray or RGB")),
    };
    let pixels = decoder
        .decode()
        .map_err(|_| invalid("pixel decode failed"))?;
    let count = info.width as usize * info.height as usize;
    if pixels.len() != count * channels {
        return Err(invalid("decoded size differs"));
    }
    let mut min = [255u8; 3];
    let mut max = [0u8; 3];
    let mut sum = [0u64; 3];
    let mut non_black = 0u64;
    for pixel in pixels.chunks_exact(channels) {
        let rgb = if channels == 1 {
            [pixel[0]; 3]
        } else {
            [pixel[0], pixel[1], pixel[2]]
        };
        if rgb.iter().any(|value| *value > 3) {
            non_black += 1;
        }
        for channel in 0..3 {
            min[channel] = min[channel].min(rgb[channel]);
            max[channel] = max[channel].max(rgb[channel]);
            sum[channel] += rgb[channel] as u64;
        }
    }
    let mean = sum.map(|value| value as f64 / count as f64);
    Ok(
        json!({"decoded":true,"width":info.width,"height":info.height,"rgbMin":min,"rgbMax":max,"rgbMean":mean,"nearBlackPixels":count as u64-non_black,"nonBlackPixels":non_black,"uniform":(0..3).all(|channel|max[channel]-min[channel]<=3),"nearBlack":max.iter().all(|value|*value<=3),"interpretation":"Exact sampled source pixels only. A flat/black sample cannot show readable or visible objects; determine from the requested edit whether it is intentional. These metrics do not certify content, motion or audio."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_real_black_from_color_and_rejects_non_image_receipts() {
        let black = inspect_jpeg(include_bytes!("../tests/fixtures/black-frame.jpg")).unwrap();
        assert_eq!(black["nearBlack"], true);
        assert_eq!(black["nonBlackPixels"], 0);
        assert_eq!(black["uniform"], true);
        let color = inspect_jpeg(include_bytes!("../tests/fixtures/color-frame.jpg")).unwrap();
        assert_eq!(color["nearBlack"], false);
        assert_eq!(color["nonBlackPixels"], 64);
        assert_eq!(color["uniform"], true);
        assert!(inspect_jpeg(&[1, 2, 3]).is_err());
        assert!(inspect_jpeg(&vec![0; 250001]).is_err());
        assert!(inspect_jpeg(&include_bytes!("../tests/fixtures/color-frame.jpg")[..30]).is_err());
    }
}
