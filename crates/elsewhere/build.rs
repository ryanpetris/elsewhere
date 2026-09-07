// Make supplies the Git-derived version through ELSEWHERE_VERSION.
// Direct Cargo builds without the override report "0.0.0-dev".
fn main() {
    println!("cargo:rerun-if-env-changed=ELSEWHERE_VERSION");
    let version = std::env::var("ELSEWHERE_VERSION").unwrap_or_else(|_| format!("{}-dev", env!("CARGO_PKG_VERSION")));
    println!("cargo:rustc-env=ELSEWHERE_VERSION={version}");
}
