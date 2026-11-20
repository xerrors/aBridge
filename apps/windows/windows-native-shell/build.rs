fn main() {
    println!("cargo:rerun-if-env-changed=ABRIDGE_CONTRACT_PATH");
    let source = std::env::var("ABRIDGE_CONTRACT_PATH")
        .expect("Build via npm run windows:shell:check to generate the shared protocol contract");
    println!("cargo:rerun-if-changed={source}");
    let bytes = std::fs::read(source).expect("Read generated desktop contract");
    let contract: serde_json::Value = serde_json::from_slice(&bytes).expect("Valid contract JSON");
    println!(
        "cargo:rustc-env=ABRIDGE_VERSION={}",
        contract["version"].as_str().expect("Product version")
    );
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("contract.json"),
        bytes,
    )
    .expect("Write embedded desktop contract");
    println!("cargo:rerun-if-env-changed=ABRIDGE_VERSION");
    println!("cargo:rerun-if-env-changed=ABRIDGE_ICON");
    println!("cargo:rerun-if-changed=app.manifest");
    let package: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../../../package.json").expect("root package.json"),
    )
    .expect("root metadata");
    let version = package["version"]
        .as_str()
        .expect("root version")
        .to_string();
    println!("cargo:rerun-if-changed=../../../package.json");
    let mut resource = winresource::WindowsResource::new();
    let mut parts = version
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse::<u64>().expect("numeric version"));
    let numeric = (parts.next().unwrap_or(0) << 48)
        | (parts.next().unwrap_or(0) << 32)
        | (parts.next().unwrap_or(0) << 16);
    resource
        .set_version_info(winresource::VersionInfo::FILEVERSION, numeric)
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, numeric);
    resource
        .set("ProductName", "aBridge")
        .set("FileDescription", "aBridge")
        .set("ProductVersion", &version)
        .set("FileVersion", &version)
        .set_manifest_file("app.manifest");
    if let Ok(icon) = std::env::var("ABRIDGE_ICON") {
        resource.set_icon(&icon);
    }
    resource.compile().expect("Windows resources");
}
