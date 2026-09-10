//! Session-scoped defaults for GTK client titlebars.

use anyhow::Result;

pub fn defaults() -> Result<tempfile::TempDir> {
    let directory = tempfile::Builder::new().prefix("elsewhere-gtk-").tempdir()?;
    let schemas = directory.path().join("glib-2.0/schemas");
    std::fs::create_dir_all(&schemas)?;
    std::fs::write(schemas.join("gschemas.compiled"), include_bytes!(concat!(env!("OUT_DIR"), "/gschemas.compiled")))?;
    Ok(directory)
}
