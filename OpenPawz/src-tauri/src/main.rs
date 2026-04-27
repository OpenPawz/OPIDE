// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The standalone OpenPawz binary was retired in OPIDE phase 1; the engine
// is now consumed exclusively as a library by the `opide` crate. Building
// this binary still works for compatibility but it does nothing.
fn main() {
    eprintln!(
        "openpawz: standalone binary disabled (phase 1 extraction). \
         Run the OPIDE app instead."
    );
}
