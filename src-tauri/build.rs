fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "dispatch",
        "preview_import_document",
        "import_document",
        "read_document",
        "open_document",
        "import_knowledge",
        "read_knowledge",
        "open_knowledge",
        "open_source_link",
        "manage_backup",
        "export_interview_document",
        "test_ai",
        "cancel_ai",
        "get_quick_controls",
        "set_quick_control",
        "show_todo_window",
        "set_todo_on_top",
        "minimize_todo_window",
        "navigate_main",
        "chat_dispatch",
        "chat_send",
        "chat_cancel",
        "generate_interview",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build ResumeDesk platform resources");
}
