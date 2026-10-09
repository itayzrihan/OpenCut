use crate::AgentError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Provider reasoning items and their tool calls/results are an indivisible
/// group. Encrypted reasoning is forwarded only to its provider, never the UI.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextGroup {
    pub id: String,
    pub items: Vec<Value>,
    #[serde(default)]
    pub receipts: Vec<ReceiptReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptReference {
    pub call_id: String,
    pub capability_id: String,
    pub revision: Option<u64>,
    pub committed: bool,
    /// A durable host write that did not modify the editor document. Its receipt
    /// is retained, but visual QA of an unchanged film cannot verify that write.
    #[serde(default)]
    pub external_only: bool,
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInput {
    pub request: String,
    pub steering: Vec<String>,
    pub plan: Value,
    pub contracts: Vec<Value>,
    pub knowledge: Vec<Value>,
    #[serde(default)]
    pub conversation: Vec<Value>,
    pub groups: Vec<ContextGroup>,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompiledContext {
    pub request: String,
    pub steering: Vec<String>,
    pub plan: Value,
    pub contracts: Vec<Value>,
    pub knowledge: Vec<Value>,
    pub conversation: Vec<Value>,
    pub groups: Vec<ContextGroup>,
    pub earlier_receipts: Vec<ReceiptReference>,
    pub evicted_group_ids: Vec<String>,
}

fn size<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .expect("serializable context")
        .len()
}

pub fn compile_context(input: ContextInput) -> Result<CompiledContext, AgentError> {
    let budget = input.max_bytes.clamp(4096, 1_000_000);
    let mut output = CompiledContext {
        request: input.request,
        steering: input.steering,
        plan: input.plan,
        contracts: input.contracts,
        knowledge: Vec::new(),
        conversation: Vec::new(),
        groups: Vec::new(),
        earlier_receipts: Vec::new(),
        evicted_group_ids: Vec::new(),
    };
    // Never silently truncate an instruction or an exact tool schema to fit.
    if size(&output) > budget {
        return Err(AgentError::ContextLimit("request, steering and loaded contracts exceed the budget; unload contracts before continuing".into()));
    }
    // Keep newest complete rounds first. Reserve receipt space so a committed
    // mutation never disappears just because verbose output was compacted.
    let history_budget = budget.saturating_sub((budget / 8).min(8000));
    let mut evicted = Vec::new();
    let mut full = false;
    for group in input.groups.into_iter().rev() {
        if !full && size(&output) + size(&group) + 1 <= history_budget {
            output.groups.insert(0, group);
        } else {
            full = true;
            evicted.push(group);
        }
    }
    for group in evicted.iter().rev() {
        output.evicted_group_ids.push(group.id.clone());
        output
            .earlier_receipts
            .extend(group.receipts.iter().cloned());
    }
    // Receipts are durable evidence, not authorization or a fresh state read.
    // If they cannot fit, request another retrieval step instead of losing them.
    if size(&output) > budget {
        return Err(AgentError::ContextLimit("receipt references exceed the context budget; persist and retrieve a smaller working set".into()));
    }
    // Newest public history wins under pressure. It contains no executable
    // envelopes and never evicts the current request or mutation receipts.
    let mut public_history_bytes = 0;
    let public_history_budget = (budget / 4).min(32_000);
    for entry in input.conversation.into_iter().rev() {
        let entry_bytes = size(&entry) + 1;
        if public_history_bytes + entry_bytes > public_history_budget
            || size(&output) + entry_bytes > budget
        {
            break;
        }
        public_history_bytes += entry_bytes;
        output.conversation.insert(0, entry);
    }
    // The caller must supply knowledge already filtered by authenticated owner
    // and project; lower-priority retrieval never evicts the current request.
    for entry in input.knowledge {
        if size(&output) + size(&entry) + 1 <= budget {
            output.knowledge.push(entry);
        }
    }
    Ok(output)
}
