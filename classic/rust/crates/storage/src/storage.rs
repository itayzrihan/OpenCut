use bridge::export;
use serde::Deserialize;

pub const LINK_MEDIA_AT_BYTES: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaStorageDisposition {
    Copy,
    Link,
    SourcePathRequired,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStorageDispositionOptions {
    pub size: f64,
    pub has_source_path: bool,
    #[serde(default)]
    pub preserve_link: bool,
}

pub fn choose_media_storage(
    MediaStorageDispositionOptions {
        size,
        has_source_path,
        preserve_link,
    }: MediaStorageDispositionOptions,
) -> MediaStorageDisposition {
    let normalized_size = if size.is_finite() {
        size.max(0.0)
    } else {
        f64::MAX
    };

    if preserve_link && has_source_path {
        return MediaStorageDisposition::Link;
    }
    if normalized_size <= LINK_MEDIA_AT_BYTES {
        return MediaStorageDisposition::Copy;
    }
    if has_source_path {
        MediaStorageDisposition::Link
    } else {
        MediaStorageDisposition::SourcePathRequired
    }
}

#[export]
pub fn media_storage_disposition(options: MediaStorageDispositionOptions) -> String {
    match choose_media_storage(options) {
        MediaStorageDisposition::Copy => "copy",
        MediaStorageDisposition::Link => "link",
        MediaStorageDisposition::SourcePathRequired => "sourcePathRequired",
    }
    .to_owned()
}

#[export]
pub fn media_link_threshold_bytes() -> f64 {
    LINK_MEDIA_AT_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_media_up_to_and_including_one_gibibyte() {
        assert_eq!(
            choose_media_storage(MediaStorageDispositionOptions {
                size: LINK_MEDIA_AT_BYTES,
                has_source_path: true,
                preserve_link: false,
            }),
            MediaStorageDisposition::Copy
        );
    }

    #[test]
    fn links_large_media_when_a_source_path_is_available() {
        assert_eq!(
            choose_media_storage(MediaStorageDispositionOptions {
                size: LINK_MEDIA_AT_BYTES + 1.0,
                has_source_path: true,
                preserve_link: false,
            }),
            MediaStorageDisposition::Link
        );
    }

    #[test]
    fn refuses_to_copy_large_browser_only_files() {
        assert_eq!(
            choose_media_storage(MediaStorageDispositionOptions {
                size: LINK_MEDIA_AT_BYTES + 1.0,
                has_source_path: false,
                preserve_link: false,
            }),
            MediaStorageDisposition::SourcePathRequired
        );
    }
}
