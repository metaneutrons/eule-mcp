//! YubiKey OATH over PC/SC (Yubico's YKOATH protocol): TOTP codes from a
//! credential held on the key, and writing such a credential.
//!
//! Once written, the seed never leaves the key. The helper sends a time-based
//! challenge and receives a truncated HMAC, from which it forms the code. Byte
//! values follow developers.yubico.com/OATH/YKOATH_Protocol.html; the challenge
//! layout, key padding and code formatting, which that page leaves open, follow
//! Yubico's yubikey-manager (yubikit/oath.py).
//!
//!   eule-helper oath status <name>  — prints configured, missing or unavailable
//!   eule-helper oath delete <name>  — removes the credential from the key

use crate::util;
use clap::{Args as ClapArgs, Subcommand};
use std::fmt;
use zeroize::Zeroizing;

// Only the PC/SC session opens the applet; builds without PC/SC reach these
// from tests alone.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
const OATH_AID: [u8; 7] = [0xA0, 0x00, 0x00, 0x05, 0x27, 0x21, 0x01];

const INS_PUT: u8 = 0x01;
const INS_DELETE: u8 = 0x02;
const INS_LIST: u8 = 0xA1;
const INS_CALCULATE: u8 = 0xA2;
/// SELECT and CALCULATE ALL share the instruction byte; P1 tells them apart.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
const INS_SELECT: u8 = 0xA4;
const INS_CALCULATE_ALL: u8 = 0xA4;
const INS_SEND_REMAINING: u8 = 0xA5;

const TAG_NAME: u8 = 0x71;
const TAG_NAME_LIST: u8 = 0x72;
const TAG_KEY: u8 = 0x73;
const TAG_CHALLENGE: u8 = 0x74;
const TAG_TRUNCATED: u8 = 0x76;
const TAG_HOTP: u8 = 0x77;
const TAG_PROPERTY: u8 = 0x78;
const TAG_TOUCH: u8 = 0x7C;

const PROP_REQUIRE_TOUCH: u8 = 0x02;
/// Credential type TOTP (high nibble) with HMAC-SHA1 (low nibble).
const TOTP_SHA1: u8 = 0x21;
const DIGITS: u8 = 6;
const DEFAULT_PERIOD: u64 = 30;
/// Shorter keys are zero-padded to this length, which leaves the HMAC unchanged.
const HMAC_MIN_KEY: usize = 14;
/// A key longer than the SHA-1 block would have to be hashed first. Microsoft
/// seeds are far shorter, so such keys are rejected instead.
const SHA1_BLOCK: usize = 64;
const MAX_NAME_BYTES: usize = 64;

const SW_OK: u16 = 0x9000;
const SW_AUTH_REQUIRED: u16 = 0x6982;
const SW_NO_SUCH_OBJECT: u16 = 0x6984;
const SW_NO_SPACE: u16 = 0x6A84;

#[derive(Debug, PartialEq, Eq)]
pub enum OathError {
    /// This build has no PC/SC support.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Unsupported,
    /// No connected YubiKey offers the OATH applet.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    NoKey,
    /// The OATH applet is protected by a password, which the helper never holds.
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    Locked,
    NotFound,
    NotTotp,
    TouchTimeout,
    Exists,
    NoSpace,
    InvalidName,
    InvalidSeed,
    Status(u16),
    Malformed(&'static str),
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Transport(String),
}

impl fmt::Display for OathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            Self::Unsupported => write!(f, "this helper build has no YubiKey support"),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Self::NoKey => write!(f, "no YubiKey with the OATH application is connected"),
            Self::Locked => write!(f, "the YubiKey OATH application is password-protected"),
            Self::NotFound => write!(f, "the credential is not on the YubiKey"),
            Self::NotTotp => write!(f, "the credential on the YubiKey is not time-based"),
            Self::TouchTimeout => write!(f, "the YubiKey was not touched in time"),
            Self::Exists => write!(f, "a credential of that name is already on the YubiKey"),
            Self::NoSpace => write!(f, "the YubiKey has no room for another credential"),
            Self::InvalidName => {
                write!(
                    f,
                    "credential name must be 1-{MAX_NAME_BYTES} bytes without control characters"
                )
            }
            Self::InvalidSeed => write!(
                f,
                "TOTP seed must be base32 (A-Z, 2-7; at least 16 symbols) and at most {SHA1_BLOCK} bytes"
            ),
            Self::Status(sw) => write!(f, "YubiKey answered with status {sw:04X}"),
            Self::Malformed(what) => write!(f, "unexpected YubiKey response: {what}"),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Self::Transport(message) => write!(f, "smart card error: {message}"),
        }
    }
}

/// One APDU exchange with a card: the response data followed by SW1 SW2.
pub trait Transport {
    fn transmit(&mut self, apdu: &[u8]) -> Result<Vec<u8>, OathError>;
}

/// An open OATH application on one card.
pub struct Session<'t> {
    transport: &'t mut dyn Transport,
}

impl<'t> Session<'t> {
    /// Select the OATH application. A password-protected application answers
    /// with a challenge and is reported as [`OathError::Locked`].
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    pub fn open(transport: &'t mut dyn Transport) -> Result<Self, OathError> {
        let response = exchange(transport, &apdu(INS_SELECT, 0x04, 0x00, &OATH_AID)?)?;
        if parse_tlvs(&response)?.iter().any(|(tag, _)| *tag == TAG_CHALLENGE) {
            return Err(OathError::Locked);
        }
        Ok(Self { transport })
    }

    fn send(&mut self, ins: u8, p1: u8, p2: u8, data: &[u8]) -> Result<Vec<u8>, OathError> {
        exchange(self.transport, &apdu(ins, p1, p2, data)?)
    }

    /// Names of all credentials on the key.
    pub fn names(&mut self) -> Result<Vec<Vec<u8>>, OathError> {
        let data = self.send(INS_LIST, 0, 0, &[])?;
        parse_tlvs(&data)?
            .into_iter()
            .filter(|(tag, _)| *tag == TAG_NAME_LIST)
            .map(|(_, value)| {
                // The first byte is the credential type; the name follows.
                value.get(1..).map(<[u8]>::to_vec).ok_or(OathError::Malformed("empty list entry"))
            })
            .collect()
    }

    pub fn contains(&mut self, name: &str) -> Result<bool, OathError> {
        Ok(self.names()?.iter().any(|candidate| candidate.as_slice() == name.as_bytes()))
    }

    /// The credential's TOTP code at `unix_secs`. CALCULATE ALL answers for
    /// every credential at once and marks those that need a touch; for such a
    /// credential `on_touch` runs before the key starts waiting for the touch.
    pub fn code(
        &mut self,
        name: &str,
        unix_secs: u64,
        on_touch: impl FnOnce(),
    ) -> Result<Zeroizing<String>, OathError> {
        let period = period_of(name);
        let challenge = challenge(unix_secs, DEFAULT_PERIOD);
        let all = self.send(INS_CALCULATE_ALL, 0x00, 0x01, &tlv(TAG_CHALLENGE, &challenge))?;
        let tlvs = parse_tlvs(&all)?;
        let response = tlvs
            .chunks(2)
            .find(|pair| pair[0] == (TAG_NAME, name.as_bytes()))
            .and_then(|pair| pair.get(1))
            .ok_or(OathError::NotFound)?;
        match response.0 {
            TAG_TRUNCATED if period == DEFAULT_PERIOD => truncated_code(response.1),
            TAG_TRUNCATED => self.calculate(name, unix_secs, period),
            TAG_TOUCH => {
                on_touch();
                self.calculate(name, unix_secs, period)
            }
            TAG_HOTP => Err(OathError::NotTotp),
            _ => Err(OathError::Malformed("unknown CALCULATE ALL entry")),
        }
    }

    fn calculate(
        &mut self,
        name: &str,
        unix_secs: u64,
        period: u64,
    ) -> Result<Zeroizing<String>, OathError> {
        let mut data = tlv(TAG_NAME, name.as_bytes());
        data.extend(tlv(TAG_CHALLENGE, &challenge(unix_secs, period)));
        // The applet was unlocked at SELECT, so "auth required" here means the
        // touch did not come in time.
        let response = self.send(INS_CALCULATE, 0x00, 0x01, &data).map_err(|e| match e {
            OathError::Status(SW_AUTH_REQUIRED) => OathError::TouchTimeout,
            OathError::Status(SW_NO_SUCH_OBJECT) => OathError::NotFound,
            other => other,
        })?;
        let tlvs = parse_tlvs(&response)?;
        let (_, value) = tlvs
            .iter()
            .find(|(tag, _)| *tag == TAG_TRUNCATED)
            .ok_or(OathError::Malformed("CALCULATE without a truncated response"))?;
        truncated_code(value)
    }

    /// Store a TOTP (HMAC-SHA1, 6 digits, 30 s) credential, replacing one of
    /// the same name.
    pub fn put(&mut self, name: &str, key: &[u8], touch: bool) -> Result<(), OathError> {
        validate_name(name)?;
        if key.is_empty() || key.len() > SHA1_BLOCK {
            return Err(OathError::InvalidSeed);
        }
        // Every buffer that holds the key is sized up front and zeroized on drop,
        // so no reallocation leaves a copy behind.
        let mut key_value = Zeroizing::new(Vec::with_capacity(2 + SHA1_BLOCK));
        key_value.extend([TOTP_SHA1, DIGITS]);
        key_value.extend_from_slice(key);
        key_value.resize(2 + key.len().max(HMAC_MIN_KEY), 0);
        let mut data = Zeroizing::new(Vec::with_capacity(8 + MAX_NAME_BYTES + key_value.len()));
        push_tlv(&mut data, TAG_NAME, name.as_bytes());
        push_tlv(&mut data, TAG_KEY, &key_value);
        if touch {
            data.extend([TAG_PROPERTY, PROP_REQUIRE_TOUCH]);
        }
        self.send(INS_PUT, 0, 0, &data).map(|_| ()).map_err(|e| match e {
            OathError::Status(SW_NO_SPACE) => OathError::NoSpace,
            other => other,
        })
    }

    pub fn delete(&mut self, name: &str) -> Result<(), OathError> {
        self.send(INS_DELETE, 0, 0, &tlv(TAG_NAME, name.as_bytes())).map(|_| ()).map_err(
            |e| match e {
                OathError::Status(SW_NO_SUCH_OBJECT) => OathError::NotFound,
                other => other,
            },
        )
    }
}

/// Send one command, following response chaining (SW 61xx → SEND REMAINING).
fn exchange(transport: &mut dyn Transport, command: &[u8]) -> Result<Vec<u8>, OathError> {
    let mut data = Vec::new();
    let mut response = transport.transmit(command)?;
    loop {
        if response.len() < 2 {
            return Err(OathError::Malformed("response without status word"));
        }
        let split = response.len() - 2;
        data.extend_from_slice(&response[..split]);
        let sw = u16::from_be_bytes([response[split], response[split + 1]]);
        match sw {
            SW_OK => return Ok(data),
            sw if sw >> 8 == 0x61 => {
                response = transport.transmit(&apdu(INS_SEND_REMAINING, 0, 0, &[])?)?;
            }
            sw => return Err(OathError::Status(sw)),
        }
    }
}

/// Short APDU. Like yubikey-manager, a command without data carries Lc = 0.
fn apdu(ins: u8, p1: u8, p2: u8, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, OathError> {
    let length = u8::try_from(data.len()).map_err(|_| OathError::Malformed("command too long"))?;
    let mut command = Zeroizing::new(Vec::with_capacity(5 + data.len()));
    command.extend([0x00, ins, p1, p2, length]);
    command.extend_from_slice(data);
    Ok(command)
}

fn push_tlv(out: &mut Vec<u8>, tag: u8, value: &[u8]) {
    out.push(tag);
    match value.len() {
        len @ 0..=0x7F => out.push(len as u8),
        len @ 0x80..=0xFF => out.extend([0x81, len as u8]),
        len => out.extend([0x82, (len >> 8) as u8, len as u8]),
    }
    out.extend_from_slice(value);
}

fn tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + value.len());
    push_tlv(&mut out, tag, value);
    out
}

const TRUNCATED_TLV: OathError = OathError::Malformed("truncated TLV");

/// Split a sequence of BER-TLVs with one-byte tags.
fn parse_tlvs(mut data: &[u8]) -> Result<Vec<(u8, &[u8])>, OathError> {
    let mut out = Vec::new();
    while let [tag, first, rest @ ..] = data {
        let (len, rest) = match *first {
            len @ 0..=0x7F => (len as usize, rest),
            0x81 => match rest {
                [len, rest @ ..] => (*len as usize, rest),
                _ => return Err(TRUNCATED_TLV),
            },
            0x82 => match rest {
                [high, low, rest @ ..] => (usize::from(u16::from_be_bytes([*high, *low])), rest),
                _ => return Err(TRUNCATED_TLV),
            },
            _ => return Err(OathError::Malformed("unsupported TLV length")),
        };
        if rest.len() < len {
            return Err(TRUNCATED_TLV);
        }
        out.push((*tag, &rest[..len]));
        data = &rest[len..];
    }
    if data.is_empty() { Ok(out) } else { Err(TRUNCATED_TLV) }
}

/// TOTP challenge: the time step as 8 bytes, big-endian.
fn challenge(unix_secs: u64, period: u64) -> [u8; 8] {
    (unix_secs / period).to_be_bytes()
}

/// A credential name like "60/issuer:account" carries a non-default period.
fn period_of(name: &str) -> u64 {
    name.split_once('/')
        .filter(|(prefix, _)| !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|(prefix, _)| prefix.parse::<u64>().ok())
        .filter(|period| *period > 0)
        .unwrap_or(DEFAULT_PERIOD)
}

/// Code from a truncated response: the digit count, then four bytes of the
/// dynamically truncated HMAC (RFC 4226, section 5.3).
fn truncated_code(value: &[u8]) -> Result<Zeroizing<String>, OathError> {
    let [digits, a, b, c, d] = value else {
        return Err(OathError::Malformed("truncated response length"));
    };
    if !(6..=8).contains(digits) {
        return Err(OathError::Malformed("digit count"));
    }
    let digits = usize::from(*digits);
    let modulus = 10u32.pow(digits as u32);
    let code = (u32::from_be_bytes([*a, *b, *c, *d]) & 0x7FFF_FFFF) % modulus;
    Ok(Zeroizing::new(format!("{code:0digits$}")))
}

fn validate_name(name: &str) -> Result<(), OathError> {
    let length_ok = (1..=MAX_NAME_BYTES).contains(&name.len());
    if length_ok && !name.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(OathError::InvalidName)
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod card {
    use super::{OathError, Session, Transport};

    struct CardTransport<'a>(&'a pcsc::Card);

    impl Transport for CardTransport<'_> {
        fn transmit(&mut self, apdu: &[u8]) -> Result<Vec<u8>, OathError> {
            let mut buffer = [0u8; pcsc::MAX_BUFFER_SIZE];
            self.0.transmit(apdu, &mut buffer).map(<[u8]>::to_vec).map_err(map_error)
        }
    }

    fn map_error(error: pcsc::Error) -> OathError {
        use pcsc::Error::*;
        match error {
            NoReadersAvailable | NoService | ServiceStopped | NoSmartcard | RemovedCard
            | ReaderUnavailable | UnknownReader => OathError::NoKey,
            other => OathError::Transport(other.to_string()),
        }
    }

    /// Run `operation` on the first connected card with an OATH application.
    /// The card is shared with other programs, used inside a transaction and
    /// left as it was afterwards rather than reset.
    pub fn with_session<R>(
        operation: impl FnOnce(&mut Session<'_>) -> Result<R, OathError>,
    ) -> Result<R, OathError> {
        let context = pcsc::Context::establish(pcsc::Scope::User).map_err(map_error)?;
        let readers = context.list_readers_owned().map_err(map_error)?;
        let mut operation = Some(operation);
        let mut locked = false;
        for reader in &readers {
            let Ok(mut card) =
                context.connect(reader, pcsc::ShareMode::Shared, pcsc::Protocols::ANY)
            else {
                continue;
            };
            let outcome = match card.transaction() {
                Ok(transaction) => {
                    let mut transport = CardTransport(&transaction);
                    match Session::open(&mut transport) {
                        Ok(mut session) => operation.take().map(|run| run(&mut session)),
                        Err(OathError::Locked) => {
                            locked = true;
                            None
                        }
                        Err(_) => None,
                    }
                }
                Err(_) => None,
            };
            let _ = card.disconnect(pcsc::Disposition::LeaveCard);
            if let Some(result) = outcome {
                return result;
            }
        }
        Err(if locked { OathError::Locked } else { OathError::NoKey })
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
use card::with_session;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn with_session<R>(
    _operation: impl FnOnce(&mut Session<'_>) -> Result<R, OathError>,
) -> Result<R, OathError> {
    Err(OathError::Unsupported)
}

/// Current TOTP code of a credential on the connected YubiKey.
pub fn current_code(name: &str, on_touch: impl FnOnce()) -> Result<Zeroizing<String>, OathError> {
    let now = unix_now();
    with_session(|session| session.code(name, now, on_touch))
}

/// Check, before anyone types a seed, that the key is there and the name free.
pub fn check_writable(name: &str, replace: bool) -> Result<(), OathError> {
    validate_name(name)?;
    with_session(
        |session| {
            if !replace && session.contains(name)? { Err(OathError::Exists) } else { Ok(()) }
        },
    )
}

/// Write a base32 TOTP seed to the key as credential `name`.
pub fn write_credential(
    name: &str,
    seed: &str,
    touch: bool,
    replace: bool,
) -> Result<(), OathError> {
    validate_name(name)?;
    let key = Zeroizing::new(util::decode_totp_seed(seed).ok_or(OathError::InvalidSeed)?);
    with_session(|session| {
        if !replace && session.contains(name)? {
            return Err(OathError::Exists);
        }
        session.put(name, &key, touch)
    })
}

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    command: OathCommand,
}

#[derive(Subcommand)]
enum OathCommand {
    /// Print "configured", "missing" or "unavailable: <reason>" for a credential.
    Status { name: String },
    /// Delete a credential; succeeds when it is already gone.
    Delete { name: String },
}

pub fn run(args: Args) -> Result<(), String> {
    match args.command {
        OathCommand::Status { name } => {
            match with_session(|session| session.contains(&name)) {
                Ok(true) => println!("configured"),
                Ok(false) => println!("missing"),
                Err(e) => println!("unavailable: {e}"),
            }
            Ok(())
        }
        OathCommand::Delete { name } => with_session(|session| match session.delete(&name) {
            Err(OathError::NotFound) => Ok(()),
            other => other,
        })
        .map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Records every APDU and answers from a script.
    struct Script {
        sent: Vec<Vec<u8>>,
        replies: VecDeque<Vec<u8>>,
    }

    impl Script {
        fn new(replies: &[&[u8]]) -> Self {
            Self { sent: Vec::new(), replies: replies.iter().map(|r| r.to_vec()).collect() }
        }
    }

    impl Transport for Script {
        fn transmit(&mut self, apdu: &[u8]) -> Result<Vec<u8>, OathError> {
            self.sent.push(apdu.to_vec());
            self.replies.pop_front().ok_or(OathError::Malformed("script exhausted"))
        }
    }

    /// SELECT answer of an unlocked applet: version and device id.
    const SELECTED: &[u8] = &[0x79, 0x03, 5, 4, 3, 0x71, 0x02, 0xAB, 0xCD, 0x90, 0x00];
    /// RFC 4226, appendix D: count 0 truncates to 0x4c93cf18, HOTP 755224.
    const TRUNCATED_755224: [u8; 5] = [6, 0x4C, 0x93, 0xCF, 0x18];

    fn reply(tlvs: &[Vec<u8>]) -> Vec<u8> {
        let mut out: Vec<u8> = tlvs.concat();
        out.extend([0x90, 0x00]);
        out
    }

    #[test]
    fn selects_the_oath_application_and_refuses_a_locked_one() {
        let mut script = Script::new(&[SELECTED]);
        Session::open(&mut script).unwrap();
        assert_eq!(
            script.sent[0],
            [0x00, 0xA4, 0x04, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x05, 0x27, 0x21, 0x01]
        );

        let locked = [0x79, 0x03, 5, 4, 3, 0x74, 0x08, 1, 2, 3, 4, 5, 6, 7, 8, 0x90, 0x00];
        let mut script = Script::new(&[&locked]);
        assert!(matches!(Session::open(&mut script), Err(OathError::Locked)));
    }

    #[test]
    fn forms_codes_from_truncated_responses() {
        assert_eq!(truncated_code(&TRUNCATED_755224).unwrap().as_str(), "755224");
        assert_eq!(truncated_code(&[6, 0, 0, 0, 1]).unwrap().as_str(), "000001");
        assert_eq!(truncated_code(&[8, 0x4C, 0x93, 0xCF, 0x18]).unwrap().as_str(), "84755224");
        assert!(truncated_code(&[6, 1, 2, 3]).is_err());
        assert!(truncated_code(&[9, 1, 2, 3, 4]).is_err());
    }

    #[test]
    fn derives_the_challenge_and_period() {
        assert_eq!(challenge(59, 30), 1u64.to_be_bytes());
        assert_eq!(challenge(1_111_111_109, 30), 37_037_036u64.to_be_bytes());
        assert_eq!(period_of("eule:user@example.com"), 30);
        assert_eq!(period_of("60/Example:user"), 60);
        assert_eq!(period_of("Example/Team:user"), 30);
        assert_eq!(period_of("0/x"), 30);
    }

    #[test]
    fn reads_a_code_from_calculate_all_without_waiting_for_touch() {
        let all = reply(&[
            tlv(TAG_NAME, b"other"),
            tlv(TAG_TOUCH, &[6]),
            tlv(TAG_NAME, b"eule:user"),
            tlv(TAG_TRUNCATED, &TRUNCATED_755224),
        ]);
        let mut script = Script::new(&[SELECTED, &all]);
        let mut session = Session::open(&mut script).unwrap();
        let mut touched = false;
        let code = session.code("eule:user", 59, || touched = true).unwrap();
        assert_eq!(code.as_str(), "755224");
        assert!(!touched);
        let mut expected = vec![0x00, 0xA4, 0x00, 0x01, 0x0A, 0x74, 0x08];
        expected.extend(1u64.to_be_bytes());
        assert_eq!(script.sent[1], expected);
    }

    #[test]
    fn asks_for_a_touch_and_then_calculates_the_single_credential() {
        let all = reply(&[tlv(TAG_NAME, b"eule:user"), tlv(TAG_TOUCH, &[6])]);
        let single = reply(&[tlv(TAG_TRUNCATED, &TRUNCATED_755224)]);
        let mut script = Script::new(&[SELECTED, &all, &single]);
        let mut session = Session::open(&mut script).unwrap();
        let mut touched = 0;
        let code = session.code("eule:user", 59, || touched += 1).unwrap();
        assert_eq!(code.as_str(), "755224");
        assert_eq!(touched, 1);
        let mut expected = vec![0x00, 0xA2, 0x00, 0x01, 0x15];
        expected.extend(tlv(TAG_NAME, b"eule:user"));
        expected.extend(tlv(TAG_CHALLENGE, &1u64.to_be_bytes()));
        assert_eq!(script.sent[2], expected);
    }

    #[test]
    fn reports_a_missed_touch_a_missing_credential_and_hotp() {
        let all = reply(&[tlv(TAG_NAME, b"eule:user"), tlv(TAG_TOUCH, &[6])]);
        let mut script = Script::new(&[SELECTED, &all, &[0x69, 0x82]]);
        let mut session = Session::open(&mut script).unwrap();
        assert_eq!(session.code("eule:user", 59, || ()), Err(OathError::TouchTimeout));

        let all = reply(&[tlv(TAG_NAME, b"other"), tlv(TAG_TRUNCATED, &TRUNCATED_755224)]);
        let mut script = Script::new(&[SELECTED, &all]);
        let mut session = Session::open(&mut script).unwrap();
        assert_eq!(session.code("eule:user", 59, || ()), Err(OathError::NotFound));

        let all = reply(&[tlv(TAG_NAME, b"eule:user"), tlv(TAG_HOTP, &[6])]);
        let mut script = Script::new(&[SELECTED, &all]);
        let mut session = Session::open(&mut script).unwrap();
        assert_eq!(session.code("eule:user", 59, || ()), Err(OathError::NotTotp));
    }

    #[test]
    fn recalculates_a_credential_with_another_period() {
        let all = reply(&[tlv(TAG_NAME, b"60/x:user"), tlv(TAG_TRUNCATED, &[6, 0, 0, 0, 9])]);
        let single = reply(&[tlv(TAG_TRUNCATED, &TRUNCATED_755224)]);
        let mut script = Script::new(&[SELECTED, &all, &single]);
        let mut session = Session::open(&mut script).unwrap();
        assert_eq!(session.code("60/x:user", 120, || ()).unwrap().as_str(), "755224");
        assert!(script.sent[2].ends_with(&2u64.to_be_bytes()));
    }

    #[test]
    fn follows_response_chaining() {
        let mut first = tlv(TAG_NAME, b"eule:user");
        first.extend([0x61, 0x07]);
        let rest = reply(&[tlv(TAG_TRUNCATED, &TRUNCATED_755224)]);
        let mut script = Script::new(&[SELECTED, &first, &rest]);
        let mut session = Session::open(&mut script).unwrap();
        assert_eq!(session.code("eule:user", 59, || ()).unwrap().as_str(), "755224");
        assert_eq!(script.sent[2], [0x00, 0xA5, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn writes_a_padded_key_with_the_touch_property_only_when_asked() {
        let mut script = Script::new(&[SELECTED, &[0x90, 0x00], &[0x90, 0x00]]);
        let mut session = Session::open(&mut script).unwrap();
        session.put("eule:user", &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false).unwrap();
        session.put("eule:user", &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true).unwrap();

        let mut key = vec![TOTP_SHA1, DIGITS, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        key.resize(2 + HMAC_MIN_KEY, 0);
        let mut body = tlv(TAG_NAME, b"eule:user");
        body.extend(tlv(TAG_KEY, &key));
        let mut expected = vec![0x00, 0x01, 0x00, 0x00, body.len() as u8];
        expected.extend(&body);
        assert_eq!(script.sent[1], expected);

        let mut touched = body.clone();
        touched.extend([TAG_PROPERTY, PROP_REQUIRE_TOUCH]);
        let mut expected = vec![0x00, 0x01, 0x00, 0x00, touched.len() as u8];
        expected.extend(&touched);
        assert_eq!(script.sent[2], expected);
    }

    #[test]
    fn rejects_unusable_names_and_keys_before_sending() {
        let mut script = Script::new(&[SELECTED]);
        let mut session = Session::open(&mut script).unwrap();
        assert_eq!(session.put("", &[1; 20], false), Err(OathError::InvalidName));
        assert_eq!(session.put(&"x".repeat(65), &[1; 20], false), Err(OathError::InvalidName));
        assert_eq!(session.put("a\nb", &[1; 20], false), Err(OathError::InvalidName));
        assert_eq!(session.put("eule:user", &[1; 65], false), Err(OathError::InvalidSeed));
        assert_eq!(script.sent.len(), 1);
    }

    #[test]
    fn lists_names_and_maps_missing_and_full() {
        let list = reply(&[tlv(TAG_NAME_LIST, b"\x21eule:user"), tlv(TAG_NAME_LIST, b"\x21other")]);
        let mut script = Script::new(&[SELECTED, &list, &[0x6A, 0x84], &[0x69, 0x84]]);
        let mut session = Session::open(&mut script).unwrap();
        assert!(session.contains("eule:user").unwrap());
        assert_eq!(session.put("new", &[1; 20], false), Err(OathError::NoSpace));
        assert_eq!(session.delete("gone"), Err(OathError::NotFound));
        assert_eq!(script.sent[1], [0x00, 0xA1, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn parses_long_tlv_lengths_and_rejects_truncated_ones() {
        let long = tlv(TAG_NAME, &[7; 200]);
        assert_eq!(&long[..3], [TAG_NAME, 0x81, 200]);
        assert_eq!(parse_tlvs(&long).unwrap(), vec![(TAG_NAME, &[7u8; 200][..])]);
        assert!(parse_tlvs(&[TAG_NAME, 0x05, 1, 2]).is_err());
        assert!(parse_tlvs(&[TAG_NAME]).is_err());
    }
}
