//! Run the production router against a JSON fixture (stdin -> cuts on stdout).
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let options = serde_json::from_str(&input).unwrap();
    let cuts = podcast::route_podcast_multicam(options);
    println!("{}", serde_json::to_string(&cuts).unwrap());
}
