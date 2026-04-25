// ── OPIDE Shell — UTF-8 streaming decoder ──────────────────────────────────
//
// Decode a stream of byte chunks (PTY output, LSP stdout, etc.) into UTF-8
// strings without dropping multi-byte characters that span chunk boundaries.
//
// Push raw bytes via `push`; receive complete characters back. Any trailing
// partial multi-byte sequence is buffered and prepended to the next call.
// (B109/B143 use this; the LineBuffer in OpenPawz/src-tauri/src/engine/http.rs
// is the line-oriented variant for SSE/NDJSON.)

pub struct Utf8Decoder {
    carry: Vec<u8>,
}

impl Default for Utf8Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self {
            carry: Vec::with_capacity(8),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        match std::str::from_utf8(&self.carry) {
            Ok(_) => {
                let out = String::from_utf8(std::mem::take(&mut self.carry))
                    .expect("just validated as utf-8");
                out
            }
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                if valid_up_to == 0 {
                    // Need more bytes — return nothing, keep carry intact.
                    return String::new();
                }
                let mut tail = self.carry.split_off(valid_up_to);
                let out = String::from_utf8(std::mem::take(&mut self.carry))
                    .expect("0..valid_up_to was UTF-8 validated above");
                std::mem::swap(&mut self.carry, &mut tail);
                out
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_ascii_passes_through() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.push(b"hello"), "hello");
    }

    #[test]
    fn split_two_byte_char() {
        let mut d = Utf8Decoder::new();
        // 'é' is 0xC3 0xA9
        assert_eq!(d.push(&[b'h', 0xC3]), "h");
        assert_eq!(d.push(&[0xA9, b'i']), "éi");
    }

    #[test]
    fn split_four_byte_char() {
        let mut d = Utf8Decoder::new();
        // '🦀' is F0 9F A6 80
        assert_eq!(d.push(&[0xF0, 0x9F]), "");
        assert_eq!(d.push(&[0xA6]), "");
        assert_eq!(d.push(&[0x80, b'!']), "🦀!");
    }
}
