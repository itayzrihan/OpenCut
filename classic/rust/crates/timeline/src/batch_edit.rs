//! Classic batch lifecycle policy; host owns scheduling, persistence and leases.
use bridge::export;
use serde::Deserialize;
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
pub struct BatchEditTransitionOptions { pub status: String, pub event: String }
#[export]
pub fn batch_edit_transition(o: BatchEditTransitionOptions) -> String {
    let next = match (o.status.as_str(),o.event.as_str()) {
        ("queued","import") => "importing",
        ("importing","ready") => "ready",
        ("ready","run") => "running",
        ("running","complete") => "completed",
        ("queued"|"importing"|"ready"|"running","fail") => "failed",
        ("queued"|"importing"|"ready"|"running","cancel") => "cancelled",
        ("queued"|"importing"|"ready"|"running","interrupt") => "interrupted",
        _ => "",
    };
    next.into()
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
pub struct BatchEditStatusOptions { pub status: String }
#[export]
pub fn batch_edit_is_locked(o: BatchEditStatusOptions) -> bool {
    matches!(o.status.as_str(),"queued"|"importing"|"ready"|"running")
}
#[cfg(test)]
mod tests {
 use super::*;
 fn step(s:&str,e:&str)->String {batch_edit_transition(BatchEditTransitionOptions{status:s.into(),event:e.into()})}
 #[test] fn completion_requires_import_and_edit() {
  let mut s="queued".to_string();
  for e in ["import","ready","run","complete"] {s=step(&s,e);assert!(!s.is_empty());}
  assert_eq!(s,"completed");assert_eq!(step("queued","complete"),"");assert_eq!(step("ready","complete"),"");
 }
 #[test] fn terminal_jobs_cannot_restart_or_write() {
  for s in ["completed","failed","cancelled","interrupted"] {
   assert!(!batch_edit_is_locked(BatchEditStatusOptions{status:s.into()}));
   for e in ["import","ready","run","complete","cancel","fail"] {assert_eq!(step(s,e),"");}
  }
 }
 #[test] fn queued_and_active_jobs_lock_and_can_cancel_or_fail() {
  for s in ["queued","importing","ready","running"] {
   assert!(batch_edit_is_locked(BatchEditStatusOptions{status:s.into()}));
   assert_eq!(step(s,"cancel"),"cancelled");assert_eq!(step(s,"fail"),"failed");assert_eq!(step(s,"interrupt"),"interrupted");
  }
 }
}
