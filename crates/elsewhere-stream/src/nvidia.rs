//! Match a DRM render node to the CUDA device used by FFmpeg's NVENC encoder.
use std::{ffi::CStr, os::unix::fs::{FileTypeExt, MetadataExt}, path::Path};
use anyhow::{Context, Result, bail, ensure};

pub fn pci_device(node: &Path) -> Result<Option<String>> {
    let meta = std::fs::metadata(node).context("inspect render node")?;
    ensure!(meta.file_type().is_char_device(), "render node must be a character device");
    let sys = std::path::PathBuf::from(format!("/sys/dev/char/{}:{}/device", libc::major(meta.rdev()), libc::minor(meta.rdev())));
    let driver = std::fs::read_link(sys.join("driver")).context("identify render node driver")?;
    if driver.file_name() != Some(std::ffi::OsStr::new("nvidia")) { return Ok(None); }
    let device = std::fs::canonicalize(sys).context("identify NVIDIA PCI device")?;
    Ok(Some(device.file_name().and_then(|name| name.to_str()).context("NVIDIA device has no PCI address")?.to_owned()))
}

pub fn cuda_device(pci: &str) -> Result<i32> {
    // Loaded only for NVENC: other backends do not need an installed NVIDIA userspace driver.
    // Each symbol's signature is from the CUDA Driver API; the library outlives every call.
    unsafe {
        let library = libloading::Library::new("libcuda.so.1").context("load NVIDIA CUDA driver; check driver/container compute access")?;
        let init = library.get::<unsafe extern "C" fn(u32) -> i32>(b"cuInit\0")?;
        let count = library.get::<unsafe extern "C" fn(*mut i32) -> i32>(b"cuDeviceGetCount\0")?;
        let get = library.get::<unsafe extern "C" fn(*mut i32, i32) -> i32>(b"cuDeviceGet\0")?;
        let bus = library.get::<unsafe extern "C" fn(*mut libc::c_char, i32, i32) -> i32>(b"cuDeviceGetPCIBusId\0")?;
        let checked = |code| -> Result<()> { ensure!(code == 0, "CUDA device discovery failed ({code}); check NVIDIA driver access and CUDA_VISIBLE_DEVICES"); Ok(()) };
        checked(init(0))?;
        let mut devices = 0;
        checked(count(&mut devices))?;
        for ordinal in 0..devices {
            let mut device = 0;
            checked(get(&mut device, ordinal))?;
            let mut address = [0 as libc::c_char; 32];
            checked(bus(address.as_mut_ptr(), address.len() as i32, device))?;
            let address = CStr::from_ptr(address.as_ptr()).to_str()?;
            if address.eq_ignore_ascii_case(pci) {
                tracing::info!(pci, ordinal, "matched NVIDIA encoder device");
                return Ok(ordinal);
            }
        }
    }
    bail!("selected NVIDIA render device {pci} is not visible to CUDA; check container device access and CUDA_VISIBLE_DEVICES")
}
