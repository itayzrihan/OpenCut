//! Production RMS analysis or alignment from JSON; no private media in fixtures.
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    if std::env::args().nth(1).as_deref() == Some("group-align") {
        let output = podcast::align_podcast_sources(serde_json::from_str(&input).unwrap());
        println!("{}", serde_json::to_string(&output).unwrap());
    } else if std::env::args().nth(1).as_deref() == Some("align") {
        let output = podcast::estimate_podcast_alignment(serde_json::from_str(&input).unwrap());
        println!("{}", serde_json::to_string(&output).unwrap());
    } else {
        let output = podcast::analyze_podcast_multicam(serde_json::from_str(&input).unwrap());
        println!("{}", serde_json::to_string(&output).unwrap());
    }
}
