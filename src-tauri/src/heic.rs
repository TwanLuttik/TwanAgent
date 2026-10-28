//! HEIC / HEIF photos, mostly from iPhones.
//!
//! The `image` crate does not decode HEIC. Bundling libheif would pull in an
//! HEVC decoder (patents, and libde265 is GPL), so on macOS we ask ImageIO,
//! which the system already ships. The bitmap is then stored as JPEG or PNG.
//! Models and the webview never see the original HEIC bytes.
//!
//! Other systems get a clear error. Windows can decode HEIC only when the
//! optional HEIF extension is installed, and that codec is not linked here.

use image::DynamicImage;

use crate::error::{Error, Result};

pub struct HeicDecoded {
    pub image: DynamicImage,
    /// Size stored in the file, before EXIF orientation and before downscaling.
    pub stored_width: u32,
    pub stored_height: u32,
}

pub fn is_heic_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".heic") || lower.ends_with(".heif")
}

/// ISO BMFF files start with a box header, then `ftyp`, then a 4-byte brand.
/// AVIF uses the same container but a different brand, so it stays rejected.
pub fn is_heif_bytes(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    matches!(
        &bytes[8..12],
        b"heic"
            | b"heix"
            | b"hevc"
            | b"hevx"
            | b"heim"
            | b"heis"
            | b"hevm"
            | b"hevs"
            | b"mif1"
            | b"msf1"
    )
}

pub fn should_decode_heic(name: &str, bytes: &[u8]) -> bool {
    is_heic_name(name) || is_heif_bytes(bytes)
}

pub fn decode_heic(bytes: &[u8], max_edge: u32) -> Result<HeicDecoded> {
    #[cfg(target_os = "macos")]
    {
        macos::decode(bytes, max_edge)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bytes, max_edge);
        Err(Error::Other(
            "HEIC images aren’t supported on this system.".into(),
        ))
    }
}

fn heic_err() -> Error {
    Error::Other("Couldn’t read this HEIC image.".into())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;

    use image::{DynamicImage, ImageBuffer, Rgba};

    use super::{heic_err, HeicDecoded};
    use crate::error::Result;

    #[link(name = "CoreFoundation", kind = "framework")]
    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CFDataCreate(allocator: *const c_void, bytes: *const u8, length: isize) -> *mut c_void;
        fn CFRelease(cf: *const c_void);
        fn CFNumberCreate(
            allocator: *const c_void,
            the_type: i32,
            value_ptr: *const c_void,
        ) -> *mut c_void;
        fn CFNumberGetValue(number: *const c_void, the_type: i32, value_ptr: *mut c_void) -> u8;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *mut c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;

        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGContextDrawImage(context: *mut c_void, rect: CGRect, image: *mut c_void);

        fn CGImageSourceCreateWithData(data: *const c_void, options: *const c_void) -> *mut c_void;
        fn CGImageSourceGetCount(source: *mut c_void) -> usize;
        fn CGImageSourceCopyPropertiesAtIndex(
            source: *mut c_void,
            index: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageSourceCreateThumbnailAtIndex(
            source: *mut c_void,
            index: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        static kCGImageSourceCreateThumbnailFromImageAlways: *const c_void;
        static kCGImageSourceCreateThumbnailWithTransform: *const c_void;
        static kCGImageSourceThumbnailMaxPixelSize: *const c_void;
        static kCGImagePropertyPixelWidth: *const c_void;
        static kCGImagePropertyPixelHeight: *const c_void;
    }

    const CF_NUMBER_SINT32: i32 = 3;
    const CF_NUMBER_SINT64: i32 = 4;
    /// `kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big` is straight RGBA in memory.
    const RGBA_BITMAP: u32 = 1 | (4 << 12);

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    struct Owned(*const c_void);

    impl Owned {
        fn from_raw(ptr: *mut c_void) -> Result<Self> {
            if ptr.is_null() {
                Err(heic_err())
            } else {
                Ok(Self(ptr as *const c_void))
            }
        }

        fn as_ptr(&self) -> *const c_void {
            self.0
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }

    pub fn decode(bytes: &[u8], max_edge: u32) -> Result<HeicDecoded> {
        if bytes.is_empty() {
            return Err(crate::error::Error::Other("image is empty".into()));
        }
        unsafe { decode_inner(bytes, max_edge.clamp(1, 16_384)) }
    }

    unsafe fn decode_inner(bytes: &[u8], max_edge: u32) -> Result<HeicDecoded> {
        let data = Owned::from_raw(CFDataCreate(
            ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
        ))?;
        let source = Owned::from_raw(CGImageSourceCreateWithData(data.as_ptr(), ptr::null()))?;
        if CGImageSourceGetCount(source.as_ptr() as *mut c_void) == 0 {
            return Err(heic_err());
        }
        let stored = stored_size(source.as_ptr());
        let options = thumbnail_options(max_edge)?;
        // The thumbnail API with the transform flag bakes in EXIF orientation,
        // so a sideways iPhone photo comes out upright. Drawing into a bitmap
        // context does not need a y-flip for this bitmap info.
        let cg = Owned::from_raw(CGImageSourceCreateThumbnailAtIndex(
            source.as_ptr() as *mut c_void,
            0,
            options.as_ptr(),
        ))?;
        let width = CGImageGetWidth(cg.as_ptr() as *mut c_void);
        let height = CGImageGetHeight(cg.as_ptr() as *mut c_void);
        if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
            return Err(heic_err());
        }
        let rgba = render_rgba(cg.as_ptr() as *mut c_void, width, height)?;
        let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, rgba)
            .ok_or_else(heic_err)?;
        let (stored_width, stored_height) = stored.unwrap_or((width as u32, height as u32));
        Ok(HeicDecoded {
            image: DynamicImage::ImageRgba8(image),
            stored_width,
            stored_height,
        })
    }

    unsafe fn thumbnail_options(max_edge: u32) -> Result<Owned> {
        let max = i32::try_from(max_edge).unwrap_or(i32::MAX);
        let number = Owned::from_raw(CFNumberCreate(
            ptr::null(),
            CF_NUMBER_SINT32,
            &max as *const i32 as *const c_void,
        ))?;
        let keys = [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ];
        let values = [kCFBooleanTrue, kCFBooleanTrue, number.as_ptr()];
        Owned::from_raw(CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as isize,
            &kCFTypeDictionaryKeyCallBacks as *const u8 as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const u8 as *const c_void,
        ))
    }

    unsafe fn stored_size(source: *const c_void) -> Option<(u32, u32)> {
        let props = Owned::from_raw(CGImageSourceCopyPropertiesAtIndex(
            source as *mut c_void,
            0,
            ptr::null(),
        ))
        .ok()?;
        let width = dict_u32(props.as_ptr(), kCGImagePropertyPixelWidth)?;
        let height = dict_u32(props.as_ptr(), kCGImagePropertyPixelHeight)?;
        if width == 0 || height == 0 {
            None
        } else {
            Some((width, height))
        }
    }

    unsafe fn dict_u32(dict: *const c_void, key: *const c_void) -> Option<u32> {
        let value = CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return None;
        }
        let mut number: i64 = 0;
        if CFNumberGetValue(
            value,
            CF_NUMBER_SINT64,
            &mut number as *mut i64 as *mut c_void,
        ) == 0
        {
            return None;
        }
        u32::try_from(number).ok().filter(|n| *n > 0)
    }

    unsafe fn render_rgba(image: *mut c_void, width: usize, height: usize) -> Result<Vec<u8>> {
        let len = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(heic_err)?;
        let mut rgba = vec![0u8; len];
        let space = Owned::from_raw(CGColorSpaceCreateDeviceRGB())?;
        let context = Owned::from_raw(CGBitmapContextCreate(
            rgba.as_mut_ptr() as *mut c_void,
            width,
            height,
            8,
            width * 4,
            space.as_ptr() as *mut c_void,
            RGBA_BITMAP,
        ))?;
        CGContextDrawImage(
            context.as_ptr() as *mut c_void,
            CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize {
                    width: width as f64,
                    height: height as f64,
                },
            },
            image,
        );
        unpremultiply(&mut rgba);
        Ok(rgba)
    }

    fn unpremultiply(rgba: &mut [u8]) {
        for px in rgba.chunks_exact_mut(4) {
            let alpha = px[3];
            if alpha == 255 {
                continue;
            }
            if alpha == 0 {
                px[0] = 0;
                px[1] = 0;
                px[2] = 0;
                continue;
            }
            px[0] = unscale(px[0], alpha);
            px[1] = unscale(px[1], alpha);
            px[2] = unscale(px[2], alpha);
        }
    }

    fn unscale(channel: u8, alpha: u8) -> u8 {
        ((u16::from(channel) * 255) / u16::from(alpha)) as u8
    }

    #[cfg(test)]
    pub(crate) fn heic_with_orientation(bytes: &[u8], orientation: i32) -> Result<Vec<u8>> {
        unsafe { write_with_orientation(bytes, orientation) }
    }

    #[cfg(test)]
    unsafe fn write_with_orientation(bytes: &[u8], orientation: i32) -> Result<Vec<u8>> {
        use std::os::unix::ffi::OsStrExt;

        extern "C" {
            fn CFURLCreateFromFileSystemRepresentation(
                allocator: *const c_void,
                buffer: *const u8,
                len: isize,
                is_directory: u8,
            ) -> *mut c_void;
            fn CFStringCreateWithBytes(
                allocator: *const c_void,
                bytes: *const u8,
                len: isize,
                encoding: u32,
                is_external: u8,
            ) -> *mut c_void;
            fn CGImageSourceCreateImageAtIndex(
                source: *mut c_void,
                index: usize,
                options: *const c_void,
            ) -> *mut c_void;
            fn CGImageDestinationCreateWithURL(
                url: *const c_void,
                type_id: *const c_void,
                count: usize,
                options: *const c_void,
            ) -> *mut c_void;
            fn CGImageDestinationAddImage(
                dest: *mut c_void,
                image: *mut c_void,
                properties: *const c_void,
            );
            fn CGImageDestinationFinalize(dest: *mut c_void) -> u8;
            static kCGImagePropertyOrientation: *const c_void;
        }

        let data = Owned::from_raw(CFDataCreate(
            ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
        ))?;
        let source = Owned::from_raw(CGImageSourceCreateWithData(data.as_ptr(), ptr::null()))?;
        // This read does not apply orientation. The tag is written back on its own
        // so the decoder under test is what turns the picture upright.
        let cg = Owned::from_raw(CGImageSourceCreateImageAtIndex(
            source.as_ptr() as *mut c_void,
            0,
            ptr::null(),
        ))?;
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("turned.heic");
        let path_bytes = path.as_os_str().as_bytes();
        let url = Owned::from_raw(CFURLCreateFromFileSystemRepresentation(
            ptr::null(),
            path_bytes.as_ptr(),
            path_bytes.len() as isize,
            0,
        ))?;
        let uti = b"public.heic";
        let uti_str = Owned::from_raw(CFStringCreateWithBytes(
            ptr::null(),
            uti.as_ptr(),
            uti.len() as isize,
            0x0800_0100,
            0,
        ))?;
        let dest = Owned::from_raw(CGImageDestinationCreateWithURL(
            url.as_ptr(),
            uti_str.as_ptr(),
            1,
            ptr::null(),
        ))?;
        let number = Owned::from_raw(CFNumberCreate(
            ptr::null(),
            CF_NUMBER_SINT32,
            &orientation as *const i32 as *const c_void,
        ))?;
        let keys = [kCGImagePropertyOrientation];
        let values = [number.as_ptr()];
        let props = Owned::from_raw(CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks as *const u8 as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const u8 as *const c_void,
        ))?;
        CGImageDestinationAddImage(
            dest.as_ptr() as *mut c_void,
            cg.as_ptr() as *mut c_void,
            props.as_ptr(),
        );
        if CGImageDestinationFinalize(dest.as_ptr() as *mut c_void) == 0 {
            return Err(heic_err());
        }
        drop(dest);
        std::fs::read(&path).map_err(Into::into)
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn heic_via_sips(png: &[u8]) -> Vec<u8> {
    use std::process::Command;

    let dir = tempfile::tempdir().unwrap();
    let png_path = dir.path().join("in.png");
    let heic_path = dir.path().join("out.heic");
    std::fs::write(&png_path, png).unwrap();
    let output = Command::new("sips")
        .args([
            "-s",
            "format",
            "heic",
            png_path.to_str().unwrap(),
            "--out",
            heic_path.to_str().unwrap(),
        ])
        .output()
        .expect("sips");
    assert!(
        output.status.success(),
        "sips failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bytes = std::fs::read(&heic_path).unwrap();
    assert!(
        is_heif_bytes(&bytes),
        "sips did not write a HEIC file: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    bytes
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use image::GenericImageView;

    use super::*;

    fn ftyp(brand: &[u8; 4]) -> Vec<u8> {
        let mut bytes = vec![0u8; 12];
        bytes[4..8].copy_from_slice(b"ftyp");
        bytes[8..12].copy_from_slice(brand);
        bytes
    }

    #[test]
    fn recognizes_heif_brands_and_ignores_avif() {
        assert!(is_heif_bytes(&ftyp(b"heic")));
        assert!(is_heif_bytes(&ftyp(b"mif1")));
        assert!(!is_heif_bytes(&ftyp(b"avif")));
        assert!(!is_heif_bytes(b"\x89PNG\r\n\x1a\n"));
        assert!(is_heic_name("IMG.HEIC"));
        assert!(is_heic_name("folder/a.heif"));
        assert!(!is_heic_name("a.jpg"));
        assert!(!is_heic_name("heic.txt"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decodes_quadrant_colors_without_flipping() {
        use image::{ImageFormat, Rgba, RgbaImage};
        use std::io::Cursor;

        let mut img = RgbaImage::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = if y < 32 && x < 32 {
                Rgba([220, 10, 10, 255])
            } else if y < 32 {
                Rgba([10, 200, 10, 255])
            } else if x < 32 {
                Rgba([10, 10, 220, 255])
            } else {
                Rgba([240, 240, 240, 255])
            };
        }
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let decoded = decode_heic(&heic_via_sips(png.get_ref()), 2048).unwrap();
        assert_eq!(decoded.image.dimensions(), (64, 64));
        assert_eq!((decoded.stored_width, decoded.stored_height), (64, 64));
        let px = decoded.image.to_rgba8();
        assert_channel(&px, 8, 8, 0);
        assert_channel(&px, 48, 8, 1);
        assert_channel(&px, 8, 48, 2);
        let white = px.get_pixel(48, 48).0;
        assert!(
            white[0] > 180 && white[1] > 180 && white[2] > 180,
            "bottom-right should stay white, got {white:?}"
        );
    }

    #[cfg(target_os = "macos")]
    fn assert_channel(img: &image::RgbaImage, x: u32, y: u32, channel: usize) {
        let px = img.get_pixel(x, y).0;
        assert!(
            px[channel] > 160
                && px[..3]
                    .iter()
                    .enumerate()
                    .all(|(i, c)| i == channel || *c < 80),
            "pixel at {x},{y} was {px:?}, expected channel {channel} to lead"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn turns_a_sideways_heic_upright() {
        use image::{ImageFormat, Rgb, RgbImage};
        use std::io::Cursor;

        let mut img = RgbImage::new(80, 40);
        for (x, _, px) in img.enumerate_pixels_mut() {
            *px = if x < 40 {
                Rgb([220, 10, 10])
            } else {
                Rgb([10, 10, 220])
            };
        }
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let heic = heic_via_sips(png.get_ref());
        // Orientation 6 is rotate 90° clockwise. Stored pixels stay 80×40.
        let turned = macos::heic_with_orientation(&heic, 6).unwrap();
        let decoded = decode_heic(&turned, 2048).unwrap();
        assert_eq!(
            (decoded.stored_width, decoded.stored_height),
            (80, 40),
            "stored size should stay the unrotated file size"
        );
        assert_eq!(decoded.image.dimensions(), (40, 80));
        let px = decoded.image.to_rgba8();
        let top = px.get_pixel(8, 8).0;
        assert!(
            top[0] > top[2],
            "top should be the original left side (red), got {top:?}"
        );
    }
}
