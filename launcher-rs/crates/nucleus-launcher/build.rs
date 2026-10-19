//! Windows resources for the launcher binary: embeds `assets/nucleus.ico`
//! so the exe itself carries the brand mark (taskbar, Alt-Tab, shortcuts that
//! point at the exe). Purely cosmetic — the build still succeeds without the
//! asset (skipped with a warning instead of a hard error).

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    // crate → crates → launcher-rs → repo root
    let ico = std::path::Path::new(&manifest).join("../../../assets/nucleus.ico");
    if !ico.is_file() {
        println!(
            "cargo:warning=nucleus.ico not found at {} - exe icon skipped",
            ico.display()
        );
        return;
    }
    println!("cargo:rerun-if-changed={}", ico.display());
    if let Err(error) = winresource::WindowsResource::new()
        .set_icon(ico.to_string_lossy().as_ref())
        .compile()
    {
        println!("cargo:warning=icon embed failed ({error}) - exe icon skipped");
    }
}
