use bridge::export;
use serde::{Deserialize, Serialize};
use unicode_bidi::{BidiClass, bidi_class};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextDirection {
    Ltr,
    Rtl,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDirectionOptions {
    pub text: String,
    pub fallback: TextDirection,
}

/// First strong Unicode direction. Numbers and neutral punctuation inherit the
/// surrounding row instead of silently creating an LTR paragraph of their own.
#[export]
pub fn resolve_text_direction(options: TextDirectionOptions) -> TextDirection {
    for character in options.text.chars() {
        match bidi_class(character) {
            BidiClass::R | BidiClass::AL => return TextDirection::Rtl,
            BidiClass::L => return TextDirection::Ltr,
            _ => {}
        }
    }
    options.fallback
}

#[cfg(test)]
mod tests {
    use super::*;
    fn direction(text: &str, fallback: TextDirection) -> TextDirection {
        resolve_text_direction(TextDirectionOptions {
            text: text.into(),
            fallback,
        })
    }
    #[test]
    fn hebrew_first_rows_are_rtl_despite_numbers_and_punctuation() {
        for text in [
            "למה דווקא 2020?",
            "2020: למה דווקא?",
            "  !שלום OpenCut",
            "مرحبا 2020؟",
        ] {
            assert_eq!(direction(text, TextDirection::Ltr), TextDirection::Rtl);
        }
    }
    #[test]
    fn numeric_tokens_inherit_the_row_but_keep_their_logical_text() {
        for text in ["2020?", "2020!", "(2020)", "2020–2026", "6", "…", ""] {
            assert_eq!(direction(text, TextDirection::Rtl), TextDirection::Rtl);
            assert_eq!(direction(text, TextDirection::Ltr), TextDirection::Ltr);
        }
    }
    #[test]
    fn first_strong_letter_wins() {
        assert_eq!(
            direction("Why 2020? למה", TextDirection::Rtl),
            TextDirection::Ltr
        );
        assert_eq!(
            direction("שלום Hello", TextDirection::Ltr),
            TextDirection::Rtl
        );
        assert_eq!(
            direction("\u{200f}2020?", TextDirection::Ltr),
            TextDirection::Rtl
        );
    }
}
