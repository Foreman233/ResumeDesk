mod ai;
mod backup;
mod chat;
mod consent;
mod credential;
mod dashboard;
mod desktop;
mod documents;
mod interview;
mod interview_ai;
mod knowledge;
mod model;
mod store;
mod todo;
mod web_search;

#[cfg(test)]
#[path = "round_three_tests.rs"]
mod round_three_tests;
#[cfg(test)]
mod tool_hub_tests;

use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, Manager, State, Webview,
    ipc::{InvokeBody, Request, Response},
};
use tauri_plugin_dialog::DialogExt;

use crate::{
    ai::{AiState, ChatCompletions, SettingsInput},
    documents::ImportResult,
    model::*,
    store::Store,
};

struct Engine {
    store: Mutex<Store>,
    ai: Mutex<AiState>,
    desktop: desktop::DesktopRuntime,
}

impl Engine {
    fn local(&self) -> Result<MutexGuard<'_, Store>> {
        self.store
            .lock()
            .map_err(|_| message("本地工作区暂不可用，请重启 ResumeDesk。"))
    }
    fn ai_state(&self) -> Result<MutexGuard<'_, AiState>> {
        self.ai
            .lock()
            .map_err(|_| message("AI 服务暂不可用，请重启 ResumeDesk。"))
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Command {
    Todo {
        operation: todo::Command,
    },
    Knowledge {
        operation: knowledge::Command,
    },
    Interview {
        operation: interview::Command,
    },
    PrepareInterview {
        selection: interview::Selection,
        config: interview::Config,
    },
    DismissInterview {
        id: String,
    },
    KnowledgeRecent,
    Dashboard,
    DashboardLayout {
        #[serde(default)]
        surface: dashboard::Surface,
    },
    SaveDashboardLayout {
        layout: dashboard::Layout,
        #[serde(default)]
        surface: dashboard::Surface,
    },
    CandidateList {
        filter: CandidateFilter,
    },
    Candidate {
        id: i64,
    },
    RecordCandidateView {
        id: i64,
    },
    SaveCandidate {
        input: CandidateInput,
    },
    Favorite {
        id: i64,
        favorite: bool,
    },
    DeleteCandidate {
        id: i64,
    },
    Tags,
    AddNote {
        candidate_id: i64,
        body: String,
    },
    DeleteNote {
        id: i64,
        candidate_id: i64,
    },
    Jobs,
    SaveJob {
        input: JobInput,
    },
    DeleteJob {
        id: i64,
    },
    Applications {
        job_id: i64,
    },
    LinkApplication {
        candidate_id: i64,
        job_id: i64,
    },
    SaveApplication {
        id: i64,
        stage: Stage,
        note: String,
    },
    SetApplicationStage {
        id: i64,
        stage: Stage,
    },
    UnlinkApplication {
        id: i64,
    },
    DocumentText {
        reference: ResumeRef,
    },
    DeleteDocument {
        reference: ResumeRef,
    },
    Settings,
    AiStatus,
    SavePrivacy {
        privacy: Privacy,
    },
    SaveAi {
        input: SettingsInput,
    },
    AiConsents,
    ResetAiConsents {
        capability: Option<consent::Capability>,
    },
    WebSearchSettings,
    SaveWebSearch {
        input: web_search::SettingsInput,
    },
}

fn value(value: impl Serialize) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

fn dispatch_local(engine: &Engine, request: Command) -> Result<Value> {
    let mut store = engine.local()?;
    match request {
        Command::Todo { operation } => todo::dispatch(&mut store, operation),
        Command::Knowledge { operation } => knowledge::dispatch(&mut store, operation),
        Command::Interview { operation } => interview::dispatch(&mut store, operation),
        Command::PrepareInterview { selection, config } => {
            value(interview_ai::prepare(engine, &store, selection, config)?)
        }
        Command::DismissInterview { id } => {
            engine.ai_state()?.interviews.remove(&id);
            value(())
        }
        Command::KnowledgeRecent => value(knowledge::recent(&store)?),
        Command::Dashboard => value(store.dashboard()?),
        Command::DashboardLayout { surface } => value(dashboard::layout(&store, surface)?),
        Command::SaveDashboardLayout { layout, surface } => {
            value(dashboard::save(&store, surface, layout)?)
        }
        Command::CandidateList { filter } => value(store.candidate_page(&filter)?),
        Command::Candidate { id } => value(store.candidate(id)?),
        Command::RecordCandidateView { id } => value(store.record_candidate_view(id)?),
        Command::SaveCandidate { input } => value(store.save_candidate(input)?),
        Command::Favorite { id, favorite } => value(store.set_favorite(id, favorite)?),
        Command::DeleteCandidate { id } => value(store.delete_candidate(id)?),
        Command::Tags => value(store.tags(None)?),
        Command::AddNote { candidate_id, body } => value(store.add_note(candidate_id, &body)?),
        Command::DeleteNote { id, candidate_id } => value(store.delete_note(id, candidate_id)?),
        Command::Jobs => value(store.jobs()?),
        Command::SaveJob { input } => value(store.save_job(input)?),
        Command::DeleteJob { id } => value(store.delete_job(id)?),
        Command::Applications { job_id } => value(store.applications(Some(job_id), None)?),
        Command::LinkApplication {
            candidate_id,
            job_id,
        } => value(store.link_application(candidate_id, job_id)?),
        Command::SaveApplication { id, stage, note } => {
            value(store.save_application(id, stage, &note)?)
        }
        Command::SetApplicationStage { id, stage } => {
            value(store.set_application_stage(id, stage)?)
        }
        Command::UnlinkApplication { id } => value(store.unlink_application(id)?),
        Command::DocumentText { reference } => value(store.document_text(reference)?),
        Command::DeleteDocument { reference } => value(store.delete_document(reference)?),
        Command::Settings => Ok(
            json!({ "ai": ai::settings_view(&store)?, "privacy": store.privacy()?,
            "dataPath": display_path(&store.data_dir()) }),
        ),
        Command::AiStatus => value(ai::settings_view(&store)?),
        Command::SavePrivacy { privacy } => value(store.save_privacy(&privacy)?),
        Command::SaveAi { input } => {
            let output = ai::save_settings(&store, input)?;
            engine.ai_state()?.invalidate();
            engine
                .desktop
                .ai_health
                .store(0, std::sync::atomic::Ordering::Relaxed);
            value(output)
        }
        Command::AiConsents => value(consent::preferences(&store)?),
        Command::ResetAiConsents { capability } => {
            consent::ConsentManager::new(&store.db).reset(capability)?;
            let mut ai = engine.ai_state()?;
            ai.invalidate_chats();
            if capability.is_none() || capability == Some(consent::Capability::Recruiting) {
                ai.invalidate_interviews();
            }
            value(consent::preferences(&store)?)
        }
        Command::WebSearchSettings => value(web_search::settings(&store)?),
        Command::SaveWebSearch { input } => {
            let result = web_search::save_settings(&mut store, input)?;
            engine.ai_state()?.invalidate_chats();
            value(result)
        }
    }
}

async fn background<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> std::result::Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "桌面后台操作中断。".to_owned())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn dispatch(
    request: Command,
    core: State<'_, Arc<Engine>>,
    app: AppHandle,
    webview: Webview,
) -> std::result::Result<Value, String> {
    if webview.label() != "main" && !matches!(request, Command::Todo { .. }) {
        return Err("悬浮窗口仅可访问本地待办。".into());
    }
    let config_changed = matches!(
        request,
        Command::SaveAi { .. } | Command::SavePrivacy { .. }
    );
    let stage_changed = matches!(
        request,
        Command::SaveApplication { .. } | Command::SetApplicationStage { .. }
    );
    let core = core.inner().clone();
    let result = background(move || dispatch_local(&core, request)).await;
    if result.is_ok() {
        if config_changed {
            let _ = app.emit(desktop::QUICK_CHANGED, ());
        }
        if stage_changed {
            let _ = app.emit(desktop::TODOS_CHANGED, ());
        }
    }
    result
}

#[tauri::command]
async fn preview_import_document(
    request: Request<'_>,
) -> std::result::Result<documents::ImportPreview, String> {
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("缺少文件内容。".into());
    };
    let (meta, bytes) = documents::unpack(raw).map_err(|error| error.to_string())?;
    let bytes = bytes.to_vec();
    background(move || documents::preview_import(meta, &bytes)).await
}

#[tauri::command]
async fn import_document(
    request: Request<'_>,
    core: State<'_, Arc<Engine>>,
) -> std::result::Result<ImportResult, String> {
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("缺少文件内容。".into());
    };
    let (meta, bytes) = documents::unpack(raw).map_err(|e| e.to_string())?;
    let bytes = bytes.to_vec();
    let core = core.inner().clone();
    background(move || core.local()?.import(meta, &bytes)).await
}

#[tauri::command]
async fn read_document(
    reference: ResumeRef,
    core: State<'_, Arc<Engine>>,
) -> std::result::Result<Response, String> {
    let core = core.inner().clone();
    background(move || read_attachment(core.local()?.document_file(reference)?)).await
}

#[tauri::command]
async fn open_document(
    reference: ResumeRef,
    core: State<'_, Arc<Engine>>,
) -> std::result::Result<(), String> {
    let core = core.inner().clone();
    background(move || open_attachment(core.local()?.document_file(reference)?)).await
}

fn read_attachment(path: PathBuf) -> Result<Response> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take((documents::MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > documents::MAX_FILE {
        return Err(message("附件超过安全大小限制。"));
    }
    Ok(Response::new(bytes))
}

fn open_attachment(path: PathBuf) -> Result<()> {
    tauri_plugin_opener::open_path(display_path(&path), None::<&str>)
        .map_err(|_| message("系统无法打开原件，请安装与该文件类型关联的程序。"))
}

#[tauri::command]
async fn import_knowledge(
    request: Request<'_>,
    core: State<'_, Arc<Engine>>,
) -> std::result::Result<knowledge::UploadResult, String> {
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("缺少文件内容。".into());
    };
    let (meta, bytes) = documents::unpack_attachment(raw).map_err(|error| error.to_string())?;
    let bytes = bytes.to_vec();
    let core = core.inner().clone();
    background(move || {
        let mut store = core.local()?;
        knowledge::upload(&mut store, meta, &bytes)
    })
    .await
}

#[tauri::command]
async fn read_knowledge(
    id: i64,
    core: State<'_, Arc<Engine>>,
) -> std::result::Result<Response, String> {
    let core = core.inner().clone();
    background(move || {
        let store = core.local()?;
        read_attachment(knowledge::original(&store, id)?)
    })
    .await
}

#[tauri::command]
async fn open_knowledge(id: i64, core: State<'_, Arc<Engine>>) -> std::result::Result<(), String> {
    let core = core.inner().clone();
    background(move || {
        let path = {
            let store = core.local()?;
            knowledge::original(&store, id)?
        };
        open_attachment(path)?;
        let store = core.local()?;
        knowledge::record_view(&store, id)
    })
    .await
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum SourceLink {
    Knowledge { id: i64 },
    Reference { message_id: i64, ordinal: i64 },
}

#[tauri::command]
async fn open_source_link(
    source: SourceLink,
    core: State<'_, Arc<Engine>>,
) -> std::result::Result<(), String> {
    let core = core.inner().clone();
    background(move || {
        let address = {
            let store = core.local()?;
            match source {
                SourceLink::Knowledge { id } => knowledge::get(&store, id)?.validity.source_url,
                SourceLink::Reference { message_id, ordinal } => store.db.query_row(
                    "SELECT url FROM chat_reference_sources WHERE message_id=?1 AND ordinal=?2 AND url IS NOT NULL",
                    rusqlite::params![message_id,ordinal], |r| r.get(0),
                ).map_err(|_| message("找不到此网页引用。"))?,
            }
        };
        let url = knowledge::source_url(&address).ok_or_else(|| message("没有可打开的来源网址。"))?;
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
            .map_err(|_| message("系统无法打开网页来源。"))
    }).await
}

fn display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    if let Some(path) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

#[tauri::command]
async fn manage_backup(
    app: AppHandle,
    core: State<'_, Arc<Engine>>,
    restore: bool,
    confirmed: bool,
    passphrase: String,
) -> std::result::Result<Option<backup::BackupSummary>, String> {
    let core = core.inner().clone();
    background(move || {
        if restore && !confirmed {
            return Err(message("请明确确认替换当前资料库。"));
        }
        let dialog = app
            .dialog()
            .file()
            .add_filter("ResumeDesk 加密备份", &["rdbackup"]);
        let path = if restore {
            dialog
                .set_title("选择要恢复的加密备份")
                .blocking_pick_file()
        } else {
            dialog
                .set_title("保存 ResumeDesk 加密备份")
                .set_file_name("ResumeDesk.rdbackup")
                .blocking_save_file()
        };
        let Some(path) = path else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| message("请选择本地备份文件。"))?;
        let mut store = core.local()?;
        let output = if restore {
            core.ai_state()?.invalidate();
            store.restore(&path, passphrase)?
        } else {
            store.backup(&path, passphrase)?
        };
        drop(store);
        if restore {
            desktop::after_restore(&app, &core);
        }
        Ok(Some(output))
    })
    .await
}

#[tauri::command]
async fn export_interview_document(
    request: Request<'_>,
    app: AppHandle,
    webview: Webview,
) -> std::result::Result<Option<String>, String> {
    if webview.label() != "main" {
        return Err("请从主窗口导出面试提纲。".into());
    }
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("缺少面试提纲文件。".into());
    };
    let Some((&kind, bytes)) = raw.split_first() else {
        return Err("面试提纲文件为空。".into());
    };
    let (label, extension) = match kind {
        1 if bytes.starts_with(b"%PDF-") => ("PDF 文档", "pdf"),
        2 if bytes.starts_with(b"PK\x03\x04") => ("Word 文档", "docx"),
        3 if std::str::from_utf8(bytes).is_ok() => ("纯文本", "txt"),
        _ => return Err("面试提纲格式无效。".into()),
    };
    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        return Err("面试提纲文件超过大小限制。".into());
    }
    let bytes = bytes.to_vec();
    background(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("导出面试提纲")
            .add_filter(label, &[extension])
            .set_file_name(format!("ResumeDesk-面试提纲.{extension}"))
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let mut path = file
            .into_path()
            .map_err(|_| message("请选择本地文件路径。"))?;
        if path.extension().is_none() {
            path.set_extension(extension);
        }
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        {
            return Err(message(format!("请使用 .{extension} 扩展名。")));
        }
        let parent = path
            .parent()
            .ok_or_else(|| message("请选择本地保存目录。"))?;
        let mut output = tempfile::NamedTempFile::new_in(parent)?;
        output.write_all(&bytes)?;
        output.as_file().sync_all()?;
        output.persist(&path).map_err(|error| error.error)?;
        Ok(path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn test_ai(
    id: String,
    core: State<'_, Arc<Engine>>,
    app: AppHandle,
) -> std::result::Result<ai::SettingsView, String> {
    async fn execute(id: &str, core: &Engine) -> Result<ai::SettingsView> {
        let (settings, token) = {
            let store = core.local()?;
            desktop::require_ai(&store)?;
            (
                ai::connection_settings(&store, false)?,
                core.ai_state()?.begin(id)?,
            )
        };
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => Err(message("AI 请求已取消。")),
            reply = ChatCompletions.test_connection(&settings) => reply,
        };
        let store = core.local()?;
        let mut state = core.ai_state()?;
        state.finish(id);
        if token.is_cancelled() {
            return Err(message("AI 请求已取消。"));
        }
        result?;
        ai::mark_verified(&store, &settings)?;
        ai::settings_view(&store)
    }
    let result = execute(&id, &core).await.map_err(|e| e.to_string());
    update_ai_health(&app, &core, &result);
    result
}

fn update_ai_health<T>(app: &AppHandle, core: &Engine, result: &std::result::Result<T, String>) {
    let status = match result {
        Ok(_) => 1,
        Err(text)
            if text.starts_with("连接 AI 服务")
                || text.starts_with("无法连接 AI 服务")
                || text.starts_with("等待 AI 服务响应")
                || text.starts_with("读取 AI 响应")
                || text.starts_with("AI 服务")
                || text.starts_with("API 拒绝")
                || text.starts_with("未找到 API 路径") =>
        {
            2
        }
        _ => return,
    };
    core.desktop
        .ai_health
        .store(status, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit(desktop::QUICK_CHANGED, ());
}

#[tauri::command]
fn cancel_ai(id: String, core: State<'_, Arc<Engine>>) -> std::result::Result<(), String> {
    core.ai_state().map_err(|e| e.to_string())?.cancel(&id);
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(desktop::on_window_event)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("local-navigation")
                .on_navigation(|_, url| {
                    let local = match (url.scheme(), url.host_str(), url.port()) {
                        ("http" | "https", Some("tauri.localhost"), None)
                        | ("tauri", Some("localhost"), None) => true,
                        ("http", Some("127.0.0.1"), Some(1420)) => {
                            !cfg!(feature = "custom-protocol")
                        }
                        _ => false,
                    };
                    local && url.username().is_empty() && url.password().is_none()
                })
                .build(),
        );

    builder
        .setup(|app| {
            let root = match std::env::var_os("RESUMEDESK_DATA_DIR") {
                Some(path) if PathBuf::from(&path).is_absolute() => PathBuf::from(path),
                _ => app.path().app_local_data_dir()?,
            };
            if let Err(error) = open_workspace_window(app, root) {
                let handle = app.handle().clone();
                app.dialog()
                    .message(error.to_string())
                    .title("无法打开 ResumeDesk")
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .show(move |_| handle.exit(1));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dispatch,
            preview_import_document,
            import_document,
            read_document,
            open_document,
            import_knowledge,
            read_knowledge,
            open_knowledge,
            open_source_link,
            manage_backup,
            export_interview_document,
            test_ai,
            cancel_ai,
            desktop::get_quick_controls,
            desktop::set_quick_control,
            desktop::show_todo_window,
            desktop::set_todo_on_top,
            desktop::minimize_todo_window,
            desktop::navigate_main,
            chat::chat_dispatch,
            chat::chat_send,
            chat::chat_cancel,
            interview_ai::generate_interview,
        ])
        .run(tauri::generate_context!())
        .expect("Unable to launch ResumeDesk");
}

fn open_workspace_window(app: &mut tauri::App, root: PathBuf) -> Result<()> {
    let store = Store::open(&root)?;
    let webview = store.root.join("webview");
    store::reject_link(&webview)?;
    let profile = PathBuf::from(display_path(&webview));
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or_else(|| message("找不到 ResumeDesk 主窗口配置。"))?;
    let startup_error = |_| {
        message("无法初始化 Windows 界面，请检查 Microsoft Edge WebView2 Runtime 和数据目录权限。")
    };
    let window = tauri::WebviewWindowBuilder::from_config(app.handle(), config)
        .map_err(startup_error)?
        .data_directory(profile);
    let core = Arc::new(Engine {
        store: Mutex::new(store),
        ai: Mutex::new(AiState::default()),
        desktop: desktop::DesktopRuntime::default(),
    });
    app.manage(core.clone());
    window.build().map_err(startup_error)?;
    desktop::setup(app.handle(), core);
    Ok(())
}

#[cfg(test)]
mod tests;
