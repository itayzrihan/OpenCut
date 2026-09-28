//! Shared account/storage policy. Host adapters own credentials and I/O.
//! This state is a projection of authenticated identity, never authentication.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
pub mod snapshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum StorageMode {
    #[default]
    LocalOnly,
    ExternalDrive,
    PersonalDevices,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// Public identity key fingerprint; secret pairing material stays in the host.
    pub fingerprint: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageConfiguration {
    pub mode: StorageMode,
    /// Opaque host-granted folder/provider handle, never an arbitrary path or URL.
    pub destination_id: Option<String>,
    #[serde(default)]
    pub devices: Vec<Device>,
    #[serde(default)]
    pub automatic_snapshots: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountState {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub storage: StorageConfiguration,
}

pub fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid account, device or destination identifier".into());
    }
    Ok(())
}

fn validate_name(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("A non-empty name of at most 256 bytes is required".into());
    }
    Ok(())
}

impl StorageConfiguration {
    pub fn validate(&self) -> Result<(), String> {
        if self.automatic_snapshots && self.mode == StorageMode::LocalOnly { return Err("Automatic snapshots require connected storage".into()); }
        if let Some(destination) = &self.destination_id { validate_id(destination)?; }
        if self.mode == StorageMode::ExternalDrive && self.destination_id.is_none() {
            return Err("Choose an external storage destination first".into());
        }
        if self.mode != StorageMode::ExternalDrive && self.destination_id.is_some() {
            return Err("Only external-drive mode accepts a destination".into());
        }
        if self.devices.len() > 64 { return Err("At most 64 personal devices are supported".into()); }
        let mut ids = BTreeSet::new();
        let mut keys = BTreeSet::new();
        for device in &self.devices {
            validate_id(&device.id)?;
            validate_name(&device.name)?;
            if device.fingerprint.len() != 64 || !device.fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Device fingerprint must be SHA-256 hexadecimal".into());
            }
            if !ids.insert(&device.id) || !keys.insert(device.fingerprint.to_ascii_lowercase()) {
                return Err("Duplicate personal device".into());
            }
        }
        if self.mode == StorageMode::PersonalDevices && !self.devices.iter().any(|device| device.enabled) {
            return Err("Pair and enable a personal device first".into());
        }
        Ok(())
    }
}

impl AccountState {
    pub fn validate(&self) -> Result<(), String> {
        validate_id(&self.id)?;
        validate_name(&self.display_name)?;
        self.storage.validate()
    }

    /// Canonical transaction shared by Editor API and classic WASM.
    /// A host must supply its verified session identity, never a request body ID.
    pub fn configure_storage(&mut self, authenticated_id: &str, configuration: StorageConfiguration) -> Result<(), String> {
        self.validate()?;
        if authenticated_id != self.id { return Err("Account ownership mismatch".into()); }
        configuration.validate()?;
        self.storage = configuration;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account() -> AccountState { AccountState { id: "alice".into(), display_name: "Alice".into(), storage: Default::default() } }
    #[test]
    fn rejects_cross_account_change_without_mutation() {
        let mut state = account(); let before = state.clone();
        assert!(state.configure_storage("bob", StorageConfiguration::default()).is_err());
        assert_eq!(state, before);
    }
    #[test]
    fn external_drive_requires_a_granted_handle() {
        let mut state = account();
        assert!(state.configure_storage("alice", StorageConfiguration { mode: StorageMode::ExternalDrive, destination_id: None, ..Default::default() }).is_err());
        assert!(state.configure_storage("alice", StorageConfiguration { mode: StorageMode::ExternalDrive, destination_id: Some("drive_1".into()), automatic_snapshots: true, ..Default::default() }).is_ok());
        assert!(StorageConfiguration { automatic_snapshots: true, ..Default::default() }.validate().is_err());
    }
    #[test]
    fn rejects_traversal_and_unpaired_device_mode() {
        for id in ["", "../alice", "C:\\alice", "a/b", "a.b"] { assert!(validate_id(id).is_err()); }
        assert!(StorageConfiguration { mode: StorageMode::PersonalDevices, ..Default::default() }.validate().is_err());
    }
}
