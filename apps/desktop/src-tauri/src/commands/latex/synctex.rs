use super::{SynctexResult, SynctexViewResult};
use flate2::read::GzDecoder;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const MAX_SYNCTEX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHED_MAPS: usize = 4;
// SyncTeX positions are in scaled TeX points. The PDF viewer uses 72 points per inch.
const SCALED_POINTS_PER_PDF_POINT: f64 = 65_781.76;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SyncCacheKey {
    sidecar_path: PathBuf,
    len: u64,
    modified_nanos: u128,
}

struct SyncCacheSlot {
    map: Mutex<Option<Arc<SyncMap>>>,
}

#[derive(Default)]
struct SyncCache {
    order: Vec<SyncCacheKey>,
    entries: HashMap<SyncCacheKey, Arc<SyncCacheSlot>>,
}

fn global_sync_cache() -> &'static Mutex<SyncCache> {
    static CACHE: OnceLock<Mutex<SyncCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SyncCache::default()))
}

fn resolve_sidecar_key(
    pdf: &Path,
    project_root: Option<&Path>,
) -> Result<(PathBuf, bool, SyncCacheKey), String> {
    let gz = pdf.with_extension("synctex.gz");
    let (path, is_gz) = match std::fs::metadata(&gz) {
        Ok(_) => (gz, true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let plain = pdf.with_extension("synctex");
            std::fs::metadata(&plain).map_err(|error| {
                format!("Could not open SyncTeX data for {}: {error}", pdf.display())
            })?;
            (plain, false)
        }
        Err(err) => return Err(format!("Could not open SyncTeX data: {err}")),
    };
    let canonical = std::fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve SyncTeX path: {error}"))?;
    if let Some(root) = project_root {
        let canonical_root = std::fs::canonicalize(root)
            .map_err(|error| format!("Invalid project path: {error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("Access denied: SyncTeX sidecar is outside project directory".to_string());
        }
    }
    let meta = std::fs::metadata(&canonical)
        .map_err(|error| format!("Could not stat SyncTeX data: {error}"))?;
    let modified_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok((
        canonical.clone(),
        is_gz,
        SyncCacheKey {
            sidecar_path: canonical,
            len: meta.len(),
            modified_nanos,
        },
    ))
}

pub(super) fn validate_sidecar_in_project(pdf: &Path, project_root: &Path) -> Result<(), String> {
    let canonical_root = std::fs::canonicalize(project_root)
        .map_err(|error| format!("Invalid project path: {error}"))?;
    for ext in ["synctex.gz", "synctex"] {
        let candidate = pdf.with_extension(ext);
        if candidate.exists() {
            let canonical = std::fs::canonicalize(&candidate)
                .map_err(|error| format!("Could not resolve SyncTeX path: {error}"))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(
                    "Access denied: SyncTeX sidecar is outside project directory".to_string(),
                );
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

struct Location {
    page: u32,
    tag: u32,
    line: u32,
    column: u32,
    x: f64,
    baseline: f64,
    bounds: Bounds,
    is_box: bool,
}

pub(super) struct SyncMap {
    inputs: HashMap<u32, PathBuf>,
    locations: Vec<Location>,
}

impl SyncMap {
    pub(super) fn load_cached_in_project(
        pdf: &Path,
        project_root: &Path,
    ) -> Result<Arc<Self>, String> {
        Self::load_cached_inner(pdf, Some(project_root))
    }

    #[cfg(test)]
    pub(super) fn load_cached(pdf: &Path) -> Result<Arc<Self>, String> {
        Self::load_cached_inner(pdf, None)
    }

    fn load_cached_inner(pdf: &Path, project_root: Option<&Path>) -> Result<Arc<Self>, String> {
        let (sidecar_path, is_gz, key) = resolve_sidecar_key(pdf, project_root)?;
        let slot = {
            let mut cache = global_sync_cache()
                .lock()
                .map_err(|_| "SyncTeX cache lock poisoned".to_string())?;
            if let Some(existing) = cache.entries.get(&key) {
                Arc::clone(existing)
            } else {
                while cache.order.len() >= MAX_CACHED_MAPS {
                    if let Some(oldest) = cache.order.first().cloned() {
                        cache.order.remove(0);
                        cache.entries.remove(&oldest);
                    }
                }
                let created = Arc::new(SyncCacheSlot {
                    map: Mutex::new(None),
                });
                cache.order.push(key.clone());
                cache.entries.insert(key.clone(), Arc::clone(&created));
                created
            }
        };

        // Per-key lock coalesces simultaneous loads of the same sidecar/build identity.
        let mut slot_guard = slot
            .map
            .lock()
            .map_err(|_| "SyncTeX slot lock poisoned".to_string())?;
        if let Some(cached) = slot_guard.as_ref() {
            return Ok(Arc::clone(cached));
        }
        let loaded = match Self::load_sidecar(&sidecar_path, is_gz, pdf) {
            Ok(map) => Arc::new(map),
            Err(err) => {
                if let Ok(mut cache) = global_sync_cache().lock() {
                    cache.entries.remove(&key);
                    cache.order.retain(|k| k != &key);
                }
                return Err(err);
            }
        };
        *slot_guard = Some(Arc::clone(&loaded));
        Ok(loaded)
    }

    #[cfg(test)]
    pub(super) fn load(pdf: &Path) -> Result<Self, String> {
        let (sidecar_path, is_gz, _) = resolve_sidecar_key(pdf, None)?;
        Self::load_sidecar(&sidecar_path, is_gz, pdf)
    }

    fn load_sidecar(sidecar_path: &Path, is_gz: bool, pdf: &Path) -> Result<Self, String> {
        let file = File::open(sidecar_path).map_err(|error| {
            format!("Could not open SyncTeX data for {}: {error}", pdf.display())
        })?;
        let reader: Box<dyn Read> = if is_gz {
            Box::new(GzDecoder::new(file))
        } else {
            Box::new(file)
        };

        let mut data = Vec::new();
        reader
            .take(MAX_SYNCTEX_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|error| format!("Could not read SyncTeX data: {error}"))?;
        if data.len() as u64 > MAX_SYNCTEX_BYTES {
            return Err("SyncTeX data exceeds 64 MiB".to_string());
        }

        Self::parse(
            &String::from_utf8_lossy(&data),
            pdf.parent().unwrap_or(Path::new("")),
        )
    }

    fn parse(data: &str, directory: &Path) -> Result<Self, String> {
        let mut lines = data.lines();
        if !lines
            .next()
            .is_some_and(|line| line.starts_with("SyncTeX Version:"))
        {
            return Err("Invalid SyncTeX header".to_string());
        }

        let mut inputs = HashMap::new();
        let mut locations = Vec::new();
        let mut unit = 8192.0;
        let mut magnification = 1000.0;
        let mut x_offset = 0.0;
        let mut y_offset = 0.0;
        let mut page = None;
        let mut last_v = None;
        let mut boxes: Vec<Option<Bounds>> = Vec::new();

        for line in lines {
            if let Some(input) = line.strip_prefix("Input:") {
                if let Some((tag, file)) = input.split_once(':') {
                    if let (Ok(tag), false) = (tag.parse(), file.is_empty()) {
                        inputs.insert(tag, normalize_path(&directory.join(file)));
                    }
                }
                continue;
            }

            let Some(code) = line.as_bytes().first().copied() else {
                continue;
            };
            let Some(page_number) = page else {
                if code == b'{' {
                    page = line[1..].parse().ok();
                    last_v = None;
                    boxes.clear();
                } else if let Some((key, value)) = line.split_once(':') {
                    if let Ok(value) = value.parse::<i32>() {
                        match key {
                            "Unit" if value > 0 => unit = f64::from(value),
                            "Magnification" if value > 0 => magnification = f64::from(value),
                            "X Offset" => x_offset = f64::from(value),
                            "Y Offset" => y_offset = f64::from(value),
                            _ => {}
                        }
                    }
                }
                continue;
            };

            match code {
                b'}' => page = None,
                b')' | b']' => {
                    boxes.pop();
                }
                b'[' | b'(' | b'h' | b'v' | b'r' | b'x' | b'k' | b'g' | b'$' => {
                    let units = unit / SCALED_POINTS_PER_PDF_POINT;
                    let mut location = parse_location(
                        &line[1..],
                        page_number,
                        &mut last_v,
                        units * magnification / 1000.0,
                        x_offset * units,
                        y_offset * units,
                    );
                    if code == b'[' {
                        // Vertical boxes span many lines. Their children supply line geometry.
                        boxes.push(None);
                        continue;
                    }

                    if let Some(location) = location.as_mut() {
                        location.is_box = matches!(code, b'(' | b'h' | b'r') && location.is_box;
                        if !location.is_box {
                            // Glue and kerns often carry the source line for paragraph text.
                            // Borrow their horizontal box to highlight that line of the PDF.
                            location.bounds = boxes
                                .iter()
                                .rev()
                                .flatten()
                                .find(|b| {
                                    location.baseline >= b.top && location.baseline <= b.bottom
                                })
                                .copied()
                                .unwrap_or(Bounds {
                                    left: location.x,
                                    top: location.baseline - 10.0,
                                    right: location.x,
                                    bottom: location.baseline,
                                });
                        }
                    }

                    if code == b'(' {
                        boxes.push(
                            location
                                .as_ref()
                                .filter(|loc| loc.is_box)
                                .map(|loc| loc.bounds),
                        );
                    }
                    if let Some(location) = location {
                        if location.line > 0 && page_number > 0 {
                            locations.push(location);
                        }
                    }
                }
                _ => {}
            }
        }

        if inputs.is_empty() || locations.is_empty() {
            return Err("SyncTeX contains no source locations".to_string());
        }
        Ok(Self { inputs, locations })
    }

    pub(super) fn view(
        &self,
        tex: &Path,
        line: u32,
        column: u32,
    ) -> Result<SynctexViewResult, String> {
        let source = normalize_path(tex);
        let mut tags: HashSet<_> = self
            .inputs
            .iter()
            .filter_map(|(tag, file)| (file == &source).then_some(*tag))
            .collect();
        if tags.is_empty() {
            if let Ok(canonical) = source.canonicalize() {
                tags.extend(self.inputs.iter().filter_map(|(tag, file)| {
                    (file.canonicalize().ok().as_ref() == Some(&canonical)).then_some(*tag)
                }));
            }
        }

        let location = self
            .locations
            .iter()
            .filter(|loc| tags.contains(&loc.tag))
            .min_by_key(|loc| {
                (
                    loc.line.abs_diff(line),
                    loc.line > line,
                    if loc.column == 0 {
                        u32::MAX
                    } else {
                        loc.column.abs_diff(column)
                    },
                    loc.page,
                    !loc.is_box,
                )
            })
            .ok_or("Could not find PDF position for this source line")?;

        Ok(SynctexViewResult {
            page: location.page,
            x: location.x,
            y: location.baseline,
            h: location.bounds.left,
            v: location.bounds.bottom,
            width: (location.bounds.right - location.bounds.left).max(24.0),
            height: location.bounds.bottom - location.bounds.top,
        })
    }

    pub(super) fn edit(&self, page: u32, x: f64, y: f64) -> Result<SynctexResult, String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("Invalid PDF position".to_string());
        }

        let distance = |loc: &Location| {
            let b = &loc.bounds;
            let dx = (b.left - x).max(x - b.right).max(0.0);
            let dy = (b.top - y).max(y - b.bottom).max(0.0);
            dx.hypot(dy)
        };
        let (location, file) = self
            .locations
            .iter()
            .filter(|loc| loc.page == page)
            .filter_map(|loc| self.inputs.get(&loc.tag).map(|file| (loc, file)))
            .min_by(|(a, _), (b, _)| {
                distance(a)
                    .total_cmp(&distance(b))
                    .then_with(|| (y - a.baseline).abs().total_cmp(&(y - b.baseline).abs()))
                    .then_with(|| a.is_box.cmp(&b.is_box))
                    .then_with(|| (x - a.x).abs().total_cmp(&(x - b.x).abs()))
            })
            .ok_or("Could not find source location for this PDF position")?;

        Ok(SynctexResult {
            file: file.to_string_lossy().into_owned(),
            line: location.line,
            column: location.column,
        })
    }
}

fn parse_location(
    record: &str,
    page: u32,
    last_v: &mut Option<i32>,
    scale: f64,
    x_offset: f64,
    y_offset: f64,
) -> Option<Location> {
    let mut fields = record.split(':');
    let mut source = fields.next()?.split(',');
    let mut position = fields.next()?.split(',');
    let x = f64::from(position.next()?.parse::<i32>().ok()?) * scale + x_offset;
    let v = match position.next()? {
        "=" => (*last_v)?,
        value => value.parse().ok()?,
    };
    *last_v = Some(v);
    let baseline = f64::from(v) * scale + y_offset;

    let mut dimensions = fields.next().unwrap_or_default().split(',');
    let mut dimension = || {
        let value = dimensions
            .next()
            .and_then(|value| value.parse::<i32>().ok());
        f64::from(value.unwrap_or_default()) * scale
    };
    let width = dimension();
    let height = dimension().max(0.0);
    let depth = dimension().max(0.0);
    Some(Location {
        page,
        tag: source.next()?.parse().ok()?,
        line: source.next()?.parse().ok()?,
        column: source
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        x,
        baseline,
        bounds: Bounds {
            left: x.min(x + width),
            top: baseline - height,
            right: x.max(x + width),
            bottom: baseline + depth,
        },
        is_box: width != 0.0 && height + depth > 0.0,
    })
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(part);
                }
            }
            _ => normalized.push(part),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    // A Tectonic-style horizontal box and glue nodes from an included file.
    const SAMPLE: &str = "\
SyncTeX Version:1\n\
Input:1:./main.tex\n\
Input:2:\n\
Input:7:./sections/../sections/étude with spaces.tex\n\
Output:pdf\n\
Magnification:1250\n\
Unit:4\n\
X Offset:65782\n\
Y Offset:-65782\n\
Content:\n\
!155\n\
{1\n\
[1,5:0,0:6553600,6553600,0\n\
(1,2:657820,1315640:1315640,131564,65782\n\
x1,2:789384,=\n\
)\n\
]\n\
}1\n\
{2\n\
(2,1:657820,1315640:1315640,131564,65782\n\
g7,14,3:789384,=\n\
g7,14,12:986730,=\n\
g7,15:1184076,=\n\
)\n\
x99\n\
}2\n\
Postamble:\n";

    #[test]
    fn looks_up_an_included_file_in_gzip_in_both_directions() {
        let scratch = tempfile::tempdir().unwrap();
        let pdf = scratch.path().join("main.pdf");
        let file = File::create(pdf.with_extension("synctex.gz")).unwrap();
        let mut writer = GzEncoder::new(file, Compression::default());
        writer.write_all(SAMPLE.as_bytes()).unwrap();
        writer.finish().unwrap();

        let map = SyncMap::load(&pdf).unwrap();
        let source = scratch.path().join("sections/étude with spaces.tex");
        let position = map.view(&source, 14, 12).unwrap();
        assert_eq!(position.page, 2);
        assert!((position.x - 79.0).abs() < 0.01);
        assert!((position.y - 96.0).abs() < 0.01);
        assert!((position.h - 54.0).abs() < 0.01);
        assert!((position.width - 100.0).abs() < 0.01);
        assert!((position.height - 15.0).abs() < 0.01);

        let edit = map.edit(2, position.x, position.y).unwrap();
        assert_eq!(Path::new(&edit.file), source);
        assert_eq!((edit.line, edit.column), (14, 12));
        assert_eq!(map.edit(1, 65.0, 96.0).unwrap().line, 2);
        assert_eq!(map.view(&source, 16, 1).unwrap().page, 2);
        assert!(map.edit(3, 0.0, 0.0).is_err());
    }

    #[test]
    fn reads_plain_synctex_and_rejects_invalid_data() {
        let scratch = tempfile::tempdir().unwrap();
        let pdf = scratch.path().join("main.pdf");
        assert!(SyncMap::load(&pdf).is_err());
        std::fs::write(pdf.with_extension("synctex"), SAMPLE).unwrap();
        assert!(SyncMap::load(&pdf).is_ok());
        std::fs::write(pdf.with_extension("synctex"), "not SyncTeX").unwrap();
        assert!(SyncMap::load(&pdf).is_err());
    }

    #[test]
    fn caches_by_sidecar_identity_and_invalidates_on_change() {
        let scratch = tempfile::tempdir().unwrap();
        let pdf = scratch.path().join("cached.pdf");
        let sidecar = pdf.with_extension("synctex");
        std::fs::write(&sidecar, SAMPLE).unwrap();

        let first = SyncMap::load_cached(&pdf).unwrap();
        let second = SyncMap::load_cached(&pdf).unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        // Change file length so cache key changes immediately even within same timestamp tick
        let updated = format!("{SAMPLE}\n");
        std::fs::write(&sidecar, updated).unwrap();
        let third = SyncMap::load_cached(&pdf).unwrap();
        assert!(!Arc::ptr_eq(&first, &third));
    }
}
