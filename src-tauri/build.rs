use std::fs;
use std::path::Path;

fn main() {
    // Tauri caches compressed frontend files in OUT_DIR and treats any existing
    // file as finished. File::create truncates the cache before compression, so an
    // interrupted build of the main bundle leaves a 0-byte file. The next build
    // embeds that empty file, Brotli rejects it, and the release window serves
    // index.html for the script. The page stays white. Drop empty caches first.
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        let assets = Path::new(&out_dir).join("tauri-codegen-assets");
        if let Ok(entries) = fs::read_dir(assets) {
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_file() && meta.len() == 0 {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    tauri_build::build();
}
