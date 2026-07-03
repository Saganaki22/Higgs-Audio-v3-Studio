use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use thiserror::Error;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub dest_dir: String,
    pub filename: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub speed_mbps: f64,
    pub percent: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub size: u64,
}

#[derive(Error, Debug)]
pub enum DownloadError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
}

pub fn download_file(
    url: &str,
    dest_dir: &Path,
    filename: Option<&str>,
    app: &AppHandle,
) -> Result<DownloadResult, DownloadError> {
    if url.is_empty() || !url.starts_with("http") {
        return Err(DownloadError::InvalidUrl("URL must start with http".into()));
    }

    let filename = filename.map(|s| s.to_string()).unwrap_or_else(|| {
        url.rsplit('/').next().filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "model.bin".to_string())
    });

    std::fs::create_dir_all(dest_dir).map_err(|e| DownloadError::Io(e.to_string()))?;
    let dest_path = dest_dir.join(&filename);
    let tmp_path = dest_dir.join(format!("{filename}.tmp"));

    let response = ureq::get(url)
        .call()
        .map_err(|e| DownloadError::Http(e.to_string()))?;

    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = response.into_body().into_reader();
    let file = File::create(&tmp_path).map_err(|e| DownloadError::Io(e.to_string()))?;
    let mut writer = BufWriter::new(file);

    let downloaded = Arc::new(AtomicU64::new(0));
    let start_time = std::time::Instant::now();
    let mut buf = [0u8; 262144];
    let mut local_written: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| DownloadError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| DownloadError::Io(e.to_string()))?;
        local_written += n as u64;
        downloaded.store(local_written, Ordering::Relaxed);

        if last_emit.elapsed().as_millis() > 200 {
            last_emit = std::time::Instant::now();
            let elapsed_secs = start_time.elapsed().as_secs_f64();
            let speed_mbps = if elapsed_secs > 0.0 {
                (local_written as f64 / 1_000_000.0) / elapsed_secs
            } else {
                0.0
            };
            let percent = if total > 0 {
                (local_written as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    downloaded: local_written,
                    total,
                    speed_mbps,
                    percent,
                },
            );
        }
    }

    writer
        .flush()
        .map_err(|e| DownloadError::Io(e.to_string()))?;
    drop(writer);

    std::fs::rename(&tmp_path, &dest_path).map_err(|e| DownloadError::Io(e.to_string()))?;

    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            downloaded: local_written,
            total,
            speed_mbps: 0.0,
            percent: 100.0,
        },
    );

    Ok(DownloadResult {
        path: dest_path.to_string_lossy().into_owned(),
        size: local_written,
    })
}

pub fn list_model_dirs(models_root: &Path) -> Vec<ModelListing> {
    let mut listings = Vec::new();
    if let Ok(entries) = std::fs::read_dir(models_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let gguf_path = path.join("model.gguf");
            let safetensors_path = path.join("model.safetensors");
            let fallback_gguf = first_file_with_extension(&path, "gguf");
            let fallback_safetensors = first_file_with_extension(&path, "safetensors");
            let weight_path = if gguf_path.exists() {
                Some(gguf_path)
            } else if let Some(found) = fallback_gguf {
                Some(found)
            } else if safetensors_path.exists() {
                Some(safetensors_path)
            } else {
                fallback_safetensors
            };
            let has_gguf = weight_path
                .as_ref()
                .and_then(|p| p.extension())
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false);
            let has_config = path.join("config.json").exists();

            let Some(weight_path) = weight_path else {
                continue;
            };

            let dir_name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();

            let size_bytes = std::fs::metadata(weight_path).map(|m| m.len()).unwrap_or(0);

            listings.push(ModelListing {
                name: dir_name,
                path: path.to_string_lossy().into_owned(),
                format: if has_gguf { "gguf".into() } else { "safetensors".into() },
                size_bytes,
                has_config,
            });
        }
    }
    listings.sort_by(|a, b| a.name.cmp(&b.name));
    listings
}

fn first_file_with_extension(root: &Path, extension: &str) -> Option<std::path::PathBuf> {
    let mut matches: Vec<_> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case(extension))
                .unwrap_or(false)
        })
        .collect();
    matches.sort();
    matches.into_iter().next()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListing {
    pub name: String,
    pub path: String,
    pub format: String,
    pub size_bytes: u64,
    pub has_config: bool,
}
