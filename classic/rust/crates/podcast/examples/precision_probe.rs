//! Offline regression harness for local source audio; never edits a project.
use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let options: podcast::PodcastPrecisionOptions = serde_json::from_str(&input).unwrap();
    println!(
        "{}",
        serde_json::to_string(&podcast::estimate_podcast_precision(options)).unwrap()
    );
}
