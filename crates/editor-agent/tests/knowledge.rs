use opencut_editor_agent::knowledge::*;
use std::collections::BTreeSet;

fn authority(project: &str) -> KnowledgeAuthority {
    KnowledgeAuthority {
        account_id: "alice".into(),
        project_id: project.into(),
        owned_projects: BTreeSet::from(["a".into(), "b".into()]),
    }
}
fn key(id: &str) -> KnowledgeKey {
    KnowledgeKey {
        kind: KnowledgeKind::Memory,
        id: id.into(),
    }
}
fn project(id: &str) -> KnowledgeLocation {
    KnowledgeLocation::Project {
        project_id: id.into(),
    }
}
fn content(body: &str) -> KnowledgeContent {
    KnowledgeContent {
        title: "Editing preferences".into(),
        body: body.into(),
        tags: vec!["עריכה".into()],
        enabled: true,
    }
}

#[test]
fn long_skills_are_read_in_version_pinned_utf8_excerpts_after_scope_checks() {
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let auth = authority("a");
    let body = "עברית 🎬\n".repeat(5000);
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Create {
            key: key("long"),
            location: project("a"),
            content: content(&body),
        },
    )
    .unwrap();
    let mut offset = 0;
    let mut restored = String::new();
    loop {
        let response = store
            .dispatch(
                &auth,
                KnowledgeRequest::ReadExcerpt {
                    key: key("long"),
                    location: project("a"),
                    version: Some(1),
                    offset,
                    max_bytes: 12_000,
                },
                1,
            )
            .unwrap();
        assert!(response.data.to_string().len() < 40_000);
        restored.push_str(response.data["body"].as_str().unwrap());
        match response.data["nextOffset"].as_u64() {
            Some(next) => offset = next as usize,
            None => break,
        }
    }
    assert_eq!(restored, body);
    assert!(
        store
            .dispatch(
                &auth,
                KnowledgeRequest::ReadExcerpt {
                    key: key("long"),
                    location: project("a"),
                    version: Some(1),
                    offset: 1,
                    max_bytes: 12_000
                },
                1
            )
            .is_err()
    );
    let mut other = auth.clone();
    other.account_id = "bob".into();
    assert!(
        store
            .dispatch(
                &other,
                KnowledgeRequest::ReadExcerpt {
                    key: key("long"),
                    location: project("a"),
                    version: None,
                    offset: 0,
                    max_bytes: 12_000
                },
                1
            )
            .is_err()
    );
}
fn apply(
    store: &mut KnowledgeStore,
    auth: &KnowledgeAuthority,
    change: KnowledgeChange,
) -> Result<KnowledgeReceipt, opencut_editor_agent::AgentError> {
    let revision = store.revision();
    store.apply(
        auth,
        KnowledgeMutation {
            expected_revision: revision,
            idempotency_key: format!("request-{revision}"),
            change,
        },
        1791172000000,
    )
}

#[test]
fn project_override_exclusion_and_disabled_override_do_not_resurrect_global_memory() {
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let auth = authority("a");
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Create {
            key: key("tone"),
            location: KnowledgeLocation::Global,
            content: content("Global tone"),
        },
    )
    .unwrap();
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Copy {
            key: key("tone"),
            from: KnowledgeLocation::Global,
            to: project("a"),
            new_id: "tone".into(),
        },
    )
    .unwrap();
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Update {
            key: key("tone"),
            location: project("a"),
            expected_version: 1,
            content: content("טון מקומי לפרויקט"),
        },
    )
    .unwrap();
    let active = store.context(&auth, "עריכה", 20_000).unwrap();
    assert_eq!(active.memories.len(), 1);
    assert_eq!(active.memories[0].head().content.body, "טון מקומי לפרויקט");
    assert_eq!(
        store.context(&authority("b"), "", 20_000).unwrap().memories[0]
            .head()
            .content
            .body,
        "Global tone"
    );
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Enable {
            key: key("tone"),
            location: project("a"),
            expected_version: 2,
            enabled: false,
        },
    )
    .unwrap();
    assert!(
        store
            .context(&auth, "", 20_000)
            .unwrap()
            .memories
            .is_empty()
    );
    apply(
        &mut store,
        &authority("b"),
        KnowledgeChange::UseGlobal {
            key: key("tone"),
            enabled: false,
        },
    )
    .unwrap();
    assert!(
        store
            .context(&authority("b"), "", 20_000)
            .unwrap()
            .memories
            .is_empty()
    );
    assert!(
        store
            .search(&authority("b"), "Global", None, true)
            .unwrap()
            .iter()
            .any(|s| s.excluded_in_project)
    );
}

#[test]
fn ownership_is_checked_before_search_context_and_version_read() {
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let auth = authority("a");
    apply(
        &mut store,
        &authority("b"),
        KnowledgeChange::Create {
            key: key("secret"),
            location: project("b"),
            content: content("Secret-project-b UNIQUE-NEEDLE"),
        },
    )
    .unwrap();
    let context = store.context(&auth, "UNIQUE-NEEDLE", 100_000).unwrap();
    assert!(
        !serde_json::to_string(&context)
            .unwrap()
            .contains("Secret-project-b")
    );
    let mut stranger = auth.clone();
    stranger.account_id = "bob".into();
    assert!(store.search(&stranger, "", None, true).is_err());
    assert!(
        store
            .read(&stranger, &key("secret"), &project("b"))
            .is_err()
    );
    assert!(KnowledgeStore::from_json("bob", &store.to_json().unwrap()).is_err());
    let mut limited = auth.clone();
    limited.owned_projects.remove("b");
    assert!(
        store
            .search(&limited, "", Some(&project("b")), true)
            .is_err()
    );
    assert!(
        store
            .search(&limited, "UNIQUE-NEEDLE", None, true)
            .unwrap()
            .is_empty()
    );
    assert!(
        apply(
            &mut store,
            &auth,
            KnowledgeChange::Update {
                key: key("secret"),
                location: project("b"),
                expected_version: 1,
                content: content("Forbidden write")
            }
        )
        .is_err()
    );
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Copy {
            key: key("secret"),
            from: project("b"),
            to: project("a"),
            new_id: "copied".into(),
        },
    )
    .unwrap();
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Update {
            key: key("copied"),
            location: project("a"),
            expected_version: 1,
            content: content("Independent copy"),
        },
    )
    .unwrap();
    assert!(
        store
            .read(&auth, &key("secret"), &project("b"))
            .unwrap()
            .head()
            .content
            .body
            .contains("Secret-project-b")
    );
}

#[test]
fn retries_are_exact_versions_are_optimistic_and_revert_creates_a_new_version() {
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let auth = authority("a");
    let request = KnowledgeMutation {
        expected_revision: 0,
        idempotency_key: "create".into(),
        change: KnowledgeChange::Create {
            key: key("tone"),
            location: project("a"),
            content: content("First"),
        },
    };
    let first = store.apply(&auth, request.clone(), 1).unwrap();
    assert_eq!(store.apply(&auth, request.clone(), 2).unwrap(), first);
    assert_eq!(store.revision(), 1);
    let mut wrong = request.clone();
    wrong.expected_revision = 1;
    assert!(store.apply(&auth, wrong, 3).is_err());
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Update {
            key: key("tone"),
            location: project("a"),
            expected_version: 1,
            content: content("Second"),
        },
    )
    .unwrap();
    let before = store.to_json().unwrap();
    assert!(
        apply(
            &mut store,
            &auth,
            KnowledgeChange::Update {
                key: key("tone"),
                location: project("a"),
                expected_version: 1,
                content: content("Stale")
            }
        )
        .is_err()
    );
    assert_eq!(store.to_json().unwrap(), before);
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Delete {
            key: key("tone"),
            location: project("a"),
            expected_version: 2,
        },
    )
    .unwrap();
    assert!(
        store
            .effective(&auth)
            .unwrap()
            .iter()
            .all(|d| d.key != key("tone"))
    );
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Revert {
            key: key("tone"),
            location: project("a"),
            expected_version: 3,
            version: 1,
        },
    )
    .unwrap();
    let doc = store.read(&auth, &key("tone"), &project("a")).unwrap();
    assert_eq!(doc.head().version, 4);
    assert_eq!(doc.head().content.body, "First");
    assert!(!doc.head().deleted);
    let reopened = KnowledgeStore::from_json("alice", &store.to_json().unwrap()).unwrap();
    assert_eq!(
        reopened.read(&auth, &key("tone"), &project("a")).unwrap(),
        doc
    );
}

#[test]
fn builtins_are_immutable_skills_load_by_relevance_and_budgets_never_slice_bodies() {
    let mut store = KnowledgeStore::new("alice".into()).unwrap();
    let auth = authority("a");
    let builtin = builtin_documents().remove(0);
    assert!(
        apply(
            &mut store,
            &auth,
            KnowledgeChange::Delete {
                key: builtin.key.clone(),
                location: KnowledgeLocation::Builtin,
                expected_version: 1
            }
        )
        .is_err()
    );
    apply(
        &mut store,
        &auth,
        KnowledgeChange::Copy {
            key: builtin.key.clone(),
            from: KnowledgeLocation::Builtin,
            to: project("a"),
            new_id: builtin.key.id.clone(),
        },
    )
    .unwrap();
    assert!(
        store
            .context(&auth, "unrelated-query", 20_000)
            .unwrap()
            .selected_skills
            .is_empty()
    );
    let context = store.context(&auth, "editing", 20_000).unwrap();
    assert_eq!(context.selected_skills.len(), 1);
    assert_eq!(context.selected_skills[0].location, project("a"));
    assert!(store.context(&auth, "editing", 20).is_err());
    assert!(serde_json::to_string(&context).unwrap().len() < 20_000);
    assert!(
        store
            .read(&auth, &builtin.key, &KnowledgeLocation::Builtin)
            .unwrap()
            .head()
            .content
            .enabled
    );
}
