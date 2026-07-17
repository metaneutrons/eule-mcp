//! Native OS credential-store operations. Secret values are never printed.

use crate::util;
use clap::{Args as ClapArgs, Subcommand};
use std::path::PathBuf;

const SERVICE: &str = "eule-mcp";

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Write a credential to an owner-only file for local connector use.
    Get { reference: String, out: PathBuf },
    /// Delete a credential from the OS store.
    Delete { reference: String },
}

pub fn set(reference: &str, secret: &str) -> Result<(), String> {
    validate_reference(reference)?;
    keyring::Entry::new(SERVICE, reference)
        .map_err(|e| format!("opening OS credential store: {e}"))?
        .set_password(secret)
        .map_err(|e| format!("storing credential: {e}"))
}

pub fn run(args: Args) -> Result<(), String> {
    match args.command {
        Command::Get { reference, out } => {
            validate_reference(&reference)?;
            let secret = keyring::Entry::new(SERVICE, &reference)
                .map_err(|e| format!("opening OS credential store: {e}"))?
                .get_password()
                .map_err(|e| format!("reading credential {reference}: {e}"))?;
            util::write_secure(&out, &secret).map_err(|e| format!("writing credential: {e}"))
        }
        Command::Delete { reference } => {
            validate_reference(&reference)?;
            keyring::Entry::new(SERVICE, &reference)
                .map_err(|e| format!("opening OS credential store: {e}"))?
                .delete_credential()
                .map_err(|e| format!("deleting credential {reference}: {e}"))
        }
    }
}

fn validate_reference(reference: &str) -> Result<(), String> {
    let segments: Vec<_> = reference.split('/').collect();
    if reference.len() <= 512
        && segments.len() == 4
        && segments[0] == "connector"
        && segments[1..].iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "@._-".contains(c))
        })
    {
        Ok(())
    } else {
        Err("invalid Eule credential reference".into())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_reference;

    #[test]
    fn accepts_scoped_connector_references_only() {
        assert!(validate_reference("connector/personal/mail/icloud").is_ok());
        assert!(validate_reference("connector/work/mail/user@example.com").is_ok());
        assert!(validate_reference("other-app/secret").is_err());
        assert!(validate_reference("connector/../../escape").is_err());
    }
}
