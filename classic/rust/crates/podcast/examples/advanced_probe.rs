//! Read-only offline harness for the same Advanced Podcast kernels as UI/MCP.
use std::io::{self, Read};
fn main() {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).unwrap();
    let mode = std::env::args().nth(1).unwrap();
    let value = match mode.as_str() {
        "group" => serde_json::to_value(podcast::group_podcast_recordings(
            serde_json::from_str(&text).unwrap(),
        ))
        .unwrap(),
        "plan" => serde_json::to_value(podcast::plan_podcast_precision(
            serde_json::from_str(&text).unwrap(),
        ))
        .unwrap(),
        "resolve" => serde_json::to_value(podcast::resolve_podcast_precision(
            serde_json::from_str(&text).unwrap(),
        ))
        .unwrap(),
        _ => panic!("Choose group, plan or resolve"),
    };
    println!("{}", value);
}
