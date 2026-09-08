//! FFmpeg video and audio codecs, GPU conversion and native device I/O.
mod encoder;
pub mod gpu;
mod viewer;
mod running;
pub(crate) mod audio;
mod webcam;
pub mod broadcast;

pub use encoder::Encoders;
pub use viewer::{FfmpegSink, validate_software_frame};
pub use running::Running;
pub use audio::{audio_source, audio_sink};
pub use webcam::video_sink;
use elsewhere_core::Codec;

pub(crate) fn init() -> anyhow::Result<()> {
    static INITIALIZED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    INITIALIZED.get_or_init(|| {
        ffmpeg_next::log::set_level(ffmpeg_next::log::Level::Quiet);
        ffmpeg_next::init().map_err(|e| e.to_string())?;
        let result = unsafe { ffmpeg_next::ffi::avformat_network_init() };
        if result < 0 { return Err(ffmpeg_next::Error::from(result).to_string()); }
        Ok(())
    }).as_ref().map_err(|error| anyhow::anyhow!("initialize FFmpeg: {error}")).copied()
}

/// The WebCodecs codec string for the first keyframe, per the AVC/HEVC/VP9 codec registrations.
fn codec_string(codec: Codec, au: &[u8], width: u32, height: u32) -> Option<String> {
    match codec {
        Codec::H264 => {
            // SPS (nal type 7): profile_idc, constraint flags, level_idc
            let sps = nal_units(au).find(|n| n[0] & 0x1f == 7)?;
            Some(format!("avc1.{:02X}{:02X}{:02X}", sps.get(1)?, sps.get(2)?, sps.get(3)?))
        }
        Codec::Hevc => {
            // SPS (nal type 33): 2-byte header, 1 byte, then profile_tier_level
            let sps = unescape(nal_units(au).find(|n| (n[0] >> 1) & 0x3f == 33)?);
            let ptl = sps.get(3..15)?;
            let profile = ptl[0] & 0x1f;
            let tier = if ptl[0] & 0x20 != 0 { 'H' } else { 'L' };
            let compat = u32::from_be_bytes([ptl[1], ptl[2], ptl[3], ptl[4]]).reverse_bits();
            let mut constraints: Vec<u8> = ptl[5..11].to_vec();
            while constraints.len() > 1 && constraints.last() == Some(&0) {
                constraints.pop();
            }
            let constraints = constraints.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(".");
            Some(format!("hev1.{profile}.{compat:X}.{tier}{}.{constraints}", ptl[11]))
        }
        Codec::Vp9 => {
            // profile 0, 8-bit; the level only has to be high enough for the picture size
            let level = if width * height <= 1920 * 1080 { "41" } else if width * height <= 4096 * 2176 { "51" } else { "61" };
            Some(format!("vp09.00.{level}.08"))
        }
        Codec::Av1 => {
            // main profile, 8-bit, main tier; the level (4.1, 5.1, 6.1 at 60 fps) only has to cover the picture size
            let level = if width * height <= 2048 * 1088 { "09" } else if width * height <= 4096 * 2176 { "13" } else { "17" };
            Some(format!("av01.0.{level}M.08"))
        }
        Codec::Vp8 => Some("vp8".into()),
    }
}

/// Remove emulation-prevention bytes (`00 00 03` → `00 00`) from a NAL unit.
fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// NAL unit payloads (header byte first) of an Annex B access unit.
fn nal_units(au: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = vec![];
    let mut i = 0;
    while i + 3 <= au.len() {
        if au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut ends: Vec<usize> = starts.iter().skip(1).map(|&s| s - 3).collect();
    ends.push(au.len());
    starts.into_iter().zip(ends).map(move |(s, e)| &au[s..e.max(s)]).filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_high_level_42() {
        let au = [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac];
        assert_eq!(codec_string(Codec::H264, &au, 1920, 1080).as_deref(), Some("avc1.64002A"));
    }

    #[test]
    fn parses_hevc_main_level_4() {
        // VPS then SPS: profile_space 0, tier L, profile 1 (Main), compat flags 0x60000000, progressive+frame_only, level 120
        let mut au = vec![0, 0, 0, 1, 0x40, 0x01, 0x0c];
        // constraint bytes `90 00 00 00 00 00` appear escaped on the wire: `90 00 00 03 00 00 03 00`
        au.extend([0, 0, 0, 1, 0x42, 0x01, 0x01, 0x01, 0x60, 0, 0, 0x03, 0, 0x90, 0, 0, 0x03, 0, 0, 0x03, 0, 120, 0xa0]);
        assert_eq!(codec_string(Codec::Hevc, &au, 1920, 1080).as_deref(), Some("hev1.1.6.L120.90"));
        assert_eq!(codec_string(Codec::Vp9, &au, 2560, 1440).as_deref(), Some("vp09.00.51.08"));
    }

}
