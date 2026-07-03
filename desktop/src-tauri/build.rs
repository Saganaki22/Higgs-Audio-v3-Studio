fn main() {
    tauri_build::build();

    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;
        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
        let engine_dir = manifest_dir.join("resources").join("engine");
        if engine_dir.exists() {
            println!("cargo:rerun-if-changed={}", engine_dir.display());
        } else {
            println!("cargo:warning=Engine resources directory not found at: {}. Build the C++ engine and copy audiocpp_engine.dll + ggml DLLs here.", engine_dir.display());
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
}
