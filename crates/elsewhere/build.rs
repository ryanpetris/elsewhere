// Make supplies the Git-derived version through ELSEWHERE_VERSION.
// Direct Cargo builds without the override report "0.0.0-dev".
fn main() {
    println!("cargo:rerun-if-env-changed=ELSEWHERE_VERSION");
    let version = std::env::var("ELSEWHERE_VERSION").unwrap_or_else(|_| format!("{}-dev", env!("CARGO_PKG_VERSION")));
    println!("cargo:rustc-env=ELSEWHERE_VERSION={version}");
    println!("cargo:rerun-if-changed=resources/schemas");
    let status = std::process::Command::new("glib-compile-schemas")
        .args(["--strict", "--targetdir"])
        .arg(std::env::var_os("OUT_DIR").unwrap())
        .arg("resources/schemas")
        .status()
        .expect("install glib-compile-schemas to build the session's GTK defaults");
    assert!(status.success(), "could not compile session schemas");
}
