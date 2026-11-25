use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize,
    Position, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_notification::NotificationExt;

use crate::{
    Engine, ai, background, display_path,
    model::{Result, message, now},
    store::Store,
    todo,
};

pub const QUICK_CHANGED: &str = "resumedesk-quick-changed";
pub const TODOS_CHANGED: &str = "todos-changed";

const WIDGET_DEFAULT_WIDTH: f64 = 340.0;
const WIDGET_DEFAULT_HEIGHT: f64 = 450.0;
const WIDGET_MIN_SIZE: f64 = 280.0;

#[derive(Default)]
pub struct DesktopRuntime {
    pub ai_health: AtomicU8,
    tray: AtomicBool,
    notification_failed: AtomicBool,
    window_revision: AtomicU64,
    window_action: Mutex<()>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuickControls {
    pub ai_enabled: bool,
    pub confirm_ai_send: bool,
    desktop_notifications: bool,
    interview_reminders: bool,
    todo_visible: bool,
    always_on_top: bool,
    keep_in_tray: bool,
}

impl Default for QuickControls {
    fn default() -> Self {
        Self {
            ai_enabled: true,
            confirm_ai_send: true,
            desktop_notifications: true,
            interview_reminders: true,
            todo_visible: false,
            always_on_top: true,
            keep_in_tray: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "key", content = "value", rename_all = "camelCase")]
pub enum QuickChange {
    AiEnabled(bool),
    ConfirmAiSend(bool),
    DesktopNotifications(bool),
    InterviewReminders(bool),
    KeepInTray(bool),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSnapshot {
    settings: QuickControls,
    ai_health: &'static str,
    widget_visible: bool,
    tray_available: bool,
    notification_failed: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
}

impl Store {
    pub fn quick_controls(&self) -> Result<QuickControls> {
        Ok(self.widget_setting("controls")?.unwrap_or_default())
    }

    fn widget_setting<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let data: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM widget_settings WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        data.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    fn set_widget_setting(&self, key: &str, value: &impl Serialize) -> Result<()> {
        self.db.execute(
            "INSERT INTO widget_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }
}

pub fn require_ai(store: &Store) -> Result<()> {
    if store.quick_controls()?.ai_enabled {
        Ok(())
    } else {
        Err(message(
            "AI 功能已关闭。可在工作台快捷控制中心或设置中启用。",
        ))
    }
}

pub fn allow_remembered_consents(db: &rusqlite::Connection) -> Result<()> {
    db.execute(
        "INSERT INTO widget_settings(key,value) VALUES('controls','{\"confirmAiSend\":false}')
         ON CONFLICT(key) DO UPDATE SET value=json_set(value,'$.confirmAiSend',json('false'))",
        [],
    )?;
    Ok(())
}

fn snapshot(app: &AppHandle, core: &Engine) -> Result<QuickSnapshot> {
    let store = core.local()?;
    let settings = store.quick_controls()?;
    let ai = ai::settings_view(&store)?;
    let health = core.desktop.ai_health.load(Ordering::Relaxed);
    let ai_health = if !settings.ai_enabled {
        "disabled"
    } else if ai.credential_error || health == 2 {
        "error"
    } else if !ai.has_key || ai.settings.model.is_empty() {
        "missing"
    } else if ai.verified || health == 1 {
        "tested"
    } else {
        "untested"
    };
    let widget_visible = app
        .get_webview_window("todo")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    Ok(QuickSnapshot {
        settings,
        ai_health,
        widget_visible,
        tray_available: core.desktop.tray.load(Ordering::Relaxed),
        notification_failed: core.desktop.notification_failed.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub async fn get_quick_controls(
    app: AppHandle,
    core: tauri::State<'_, Arc<Engine>>,
) -> std::result::Result<QuickSnapshot, String> {
    let core = core.inner().clone();
    background(move || snapshot(&app, &core)).await
}

#[tauri::command]
pub async fn set_quick_control(
    app: AppHandle,
    core: tauri::State<'_, Arc<Engine>>,
    change: QuickChange,
) -> std::result::Result<QuickSnapshot, String> {
    let core = core.inner().clone();
    background(move || {
        {
            let store = core.local()?;
            let mut preferences = store.quick_controls()?;
            let mut invalidate = false;
            let mut reset_consents = false;
            match change {
                QuickChange::AiEnabled(value) => {
                    preferences.ai_enabled = value;
                    invalidate = true;
                }
                QuickChange::ConfirmAiSend(value) => {
                    preferences.confirm_ai_send = value;
                    invalidate = true;
                    reset_consents = value;
                }
                QuickChange::DesktopNotifications(value) => {
                    preferences.desktop_notifications = value
                }
                QuickChange::InterviewReminders(value) => preferences.interview_reminders = value,
                QuickChange::KeepInTray(value) => {
                    if value && !core.desktop.tray.load(Ordering::Relaxed) {
                        return Err(message("当前环境无法创建系统托盘图标。"));
                    }
                    preferences.keep_in_tray = value;
                }
            }
            let tx = store.db.unchecked_transaction()?;
            store.set_widget_setting("controls", &preferences)?;
            if reset_consents {
                crate::consent::ConsentManager::new(&tx).reset(None)?;
            }
            tx.commit()?;
            if invalidate {
                core.ai_state()?.invalidate();
            }
        }
        let _ = app.emit(QUICK_CHANGED, ());
        snapshot(&app, &core)
    })
    .await
}

fn create_widget(app: &AppHandle, core: &Engine) -> Result<WebviewWindow> {
    let (root, settings) = {
        let store = core.local()?;
        (store.root.clone(), store.quick_controls()?)
    };
    WebviewWindowBuilder::new(
        app,
        "todo",
        WebviewUrl::App("index.html?window=todo".into()),
    )
    .title("ResumeDesk · 悬浮待办")
    .data_directory(PathBuf::from(display_path(&root.join("webview"))))
    .inner_size(WIDGET_DEFAULT_WIDTH, WIDGET_DEFAULT_HEIGHT)
    .min_inner_size(WIDGET_MIN_SIZE, WIDGET_MIN_SIZE)
    .decorations(false)
    .shadow(true)
    .resizable(true)
    .maximizable(false)
    .visible(false)
    .always_on_top(settings.always_on_top)
    .build()
    .map_err(|_| message("无法创建悬浮待办窗口。请检查 WebView2 是否可用。"))
}

fn work_area_contains(area: &PhysicalRect<i32, u32>, point: Placement) -> bool {
    let x = i64::from(point.x) - i64::from(area.position.x);
    let y = i64::from(point.y) - i64::from(area.position.y);
    (0..i64::from(area.size.width)).contains(&x) && (0..i64::from(area.size.height)).contains(&y)
}

fn widget_bounds(
    area: &PhysicalRect<i32, u32>,
    scale: f64,
    frame: PhysicalSize<u32>,
    saved: Option<Placement>,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let minimum = LogicalSize::new(WIDGET_MIN_SIZE, WIDGET_MIN_SIZE).to_physical::<u32>(scale);
    let preferred = saved
        .map(|point| LogicalSize::new(point.width, point.height))
        .unwrap_or_else(|| LogicalSize::new(WIDGET_DEFAULT_WIDTH, WIDGET_DEFAULT_HEIGHT))
        .to_physical::<u32>(scale);
    let available_width = area.size.width.saturating_sub(frame.width);
    let available_height = area.size.height.saturating_sub(frame.height);
    let width = preferred
        .width
        .clamp(minimum.width, available_width.max(minimum.width));
    let height = preferred
        .height
        .clamp(minimum.height, available_height.max(minimum.height));
    let room_x = available_width.saturating_sub(width);
    let room_y = available_height.saturating_sub(height);
    let max_x = area.position.x.saturating_add(room_x as i32);
    let max_y = area.position.y.saturating_add(room_y as i32);
    let position = if let Some(point) = saved.filter(|point| work_area_contains(area, *point)) {
        PhysicalPosition::new(
            point.x.clamp(area.position.x, max_x),
            point.y.clamp(area.position.y, max_y),
        )
    } else {
        let margin = LogicalSize::new(16.0, 30.0).to_physical::<u32>(scale);
        PhysicalPosition::new(
            max_x.saturating_sub(margin.width.min(room_x) as i32),
            area.position
                .y
                .saturating_add(margin.height.min(room_y) as i32),
        )
    };
    (position, PhysicalSize::new(width, height))
}

fn place_widget(window: &WebviewWindow, saved: Option<Placement>) -> Result<()> {
    let all = window
        .available_monitors()
        .map_err(|_| message("无法读取显示器布局。"))?;
    let known = saved.and_then(|point| {
        all.iter()
            .find(|monitor| work_area_contains(monitor.work_area(), point))
    });
    let primary = window.primary_monitor().ok().flatten();
    let Some(monitor) = known.or(primary.as_ref()).or(all.first()) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let frame = match (
        window.outer_size(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        (Ok(outer), Ok(inner), Ok(current_scale)) => PhysicalSize::new(
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        )
        .to_logical::<f64>(current_scale)
        .to_physical::<u32>(scale),
        _ => PhysicalSize::new(0, 0),
    };
    // Apply the target monitor's DPI even when the window is still on the old monitor.
    let (position, size) = widget_bounds(monitor.work_area(), scale, frame, saved);
    window
        .set_position(Position::Physical(position))
        .map_err(|_| message("无法设置悬浮窗口位置。"))?;
    window
        .set_size(Size::Physical(size))
        .map_err(|_| message("无法设置悬浮窗口大小。"))?;
    Ok(())
}

fn set_widget(app: &AppHandle, core: &Engine, visible: bool, focus: bool) -> Result<()> {
    let _action = core
        .desktop
        .window_action
        .lock()
        .map_err(|_| message("悬浮窗口暂不可用。"))?;
    let existing = app.get_webview_window("todo");
    let was_visible = existing
        .as_ref()
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        let widget = match existing {
            Some(window) => window,
            None => create_widget(app, core)?,
        };
        if !was_visible {
            let saved = core.local()?.widget_setting("window")?;
            place_widget(&widget, saved)?;
        }
        widget
            .show()
            .map_err(|_| message("无法显示悬浮待办窗口。"))?;
        let _ = widget.unminimize();
        if focus {
            let _ = widget.set_focus();
        }
    } else if let Some(widget) = existing {
        persist_placement(&widget, core);
        widget
            .hide()
            .map_err(|_| message("无法隐藏悬浮待办窗口。"))?;
    }
    let result = (|| -> Result<()> {
        let store = core.local()?;
        let mut value = store.quick_controls()?;
        value.todo_visible = visible;
        store.set_widget_setting("controls", &value)
    })();
    if result.is_err()
        && let Some(widget) = app.get_webview_window("todo")
    {
        let _ = if was_visible {
            widget.show()
        } else {
            widget.hide()
        };
    }
    let _ = app.emit(QUICK_CHANGED, ());
    result
}

#[tauri::command]
pub async fn show_todo_window(
    app: AppHandle,
    core: tauri::State<'_, Arc<Engine>>,
    visible: bool,
) -> std::result::Result<(), String> {
    let core = core.inner().clone();
    background(move || set_widget(&app, &core, visible, visible)).await
}

#[tauri::command]
pub async fn set_todo_on_top(
    app: AppHandle,
    core: tauri::State<'_, Arc<Engine>>,
    always_on_top: bool,
) -> std::result::Result<(), String> {
    let core = core.inner().clone();
    background(move || {
        let _action = core
            .desktop
            .window_action
            .lock()
            .map_err(|_| message("悬浮窗口暂不可用。"))?;
        let store = core.local()?;
        let mut controls = store.quick_controls()?;
        let previous = controls.always_on_top;
        let window = app.get_webview_window("todo");
        if let Some(widget) = &window {
            widget
                .set_always_on_top(always_on_top)
                .map_err(|_| message("无法调整悬浮窗口置顶状态。"))?;
        }
        controls.always_on_top = always_on_top;
        let result = store.set_widget_setting("controls", &controls);
        if result.is_err()
            && let Some(widget) = &window
        {
            let _ = widget.set_always_on_top(previous);
        }
        drop(store);
        let _ = app.emit(QUICK_CHANGED, ());
        result
    })
    .await
}

#[tauri::command]
pub fn minimize_todo_window(app: AppHandle) -> std::result::Result<(), String> {
    app.get_webview_window("todo")
        .ok_or_else(|| "未找到悬浮待办窗口。".to_owned())?
        .minimize()
        .map_err(|_| "无法最小化悬浮待办窗口。".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Navigation {
    candidate_id: Option<i64>,
    job_id: Option<i64>,
    application_id: Option<i64>,
    widget: bool,
}

fn show_main(app: &AppHandle) -> Result<()> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| message("未找到主窗口。"))?;
    main.show().map_err(|_| message("无法显示主窗口。"))?;
    let _ = main.unminimize();
    let _ = main.set_focus();
    Ok(())
}

#[tauri::command]
pub fn navigate_main(
    app: AppHandle,
    candidate_id: Option<i64>,
    job_id: Option<i64>,
    application_id: Option<i64>,
    widget: Option<bool>,
) -> std::result::Result<(), String> {
    show_main(&app).map_err(|e| e.to_string())?;
    app.emit_to(
        "main",
        "resumedesk-navigate",
        Navigation {
            candidate_id,
            job_id,
            application_id,
            widget: widget.unwrap_or(false),
        },
    )
    .map_err(|_| "无法通知主窗口打开资料。".into())
}

fn persist_placement(widget: &WebviewWindow, core: &Engine) {
    if widget.is_minimized().unwrap_or(true) {
        return;
    }
    let (Ok(position), Ok(size), Ok(scale)) = (
        widget.outer_position(),
        widget.inner_size(),
        widget.scale_factor(),
    ) else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    if logical.width < 260.0 || logical.height < 230.0 {
        return;
    }
    if let Ok(store) = core.local() {
        let _ = store.set_widget_setting(
            "window",
            &Placement {
                x: position.x,
                y: position.y,
                width: logical.width,
                height: logical.height,
            },
        );
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let Some(state) = app.try_state::<Arc<Engine>>() else {
        return;
    };
    let core = state.inner().clone();
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "todo" {
            api.prevent_close();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = set_widget(&app, &core, false, false);
            });
        } else if window.label() == "main" {
            api.prevent_close();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let stays = core.desktop.tray.load(Ordering::Relaxed)
                    && core
                        .local()
                        .and_then(|store| store.quick_controls())
                        .map(|settings| settings.keep_in_tray)
                        .unwrap_or(false);
                if stays {
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.hide();
                    }
                } else {
                    if let Some(widget) = app.get_webview_window("todo") {
                        persist_placement(&widget, &core);
                    }
                    app.exit(0);
                }
            });
        }
        return;
    }
    if window.label() == "todo"
        && matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        )
    {
        let revision = core.desktop.window_revision.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(350)).await;
            if core.desktop.window_revision.load(Ordering::Relaxed) == revision
                && let Some(widget) = app.get_webview_window("todo")
            {
                persist_placement(&widget, &core);
            }
        });
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let workbench = MenuItem::with_id(app, "main", "显示 ResumeDesk", true, None::<&str>)?;
    let todo = MenuItem::with_id(app, "todo", "打开悬浮待办", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 ResumeDesk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&workbench, &todo, &quit])?;
    let mut tray = TrayIconBuilder::with_id("resumedesk")
        .menu(&menu)
        .tooltip("ResumeDesk");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "main" => {
            let _ = show_main(app);
        }
        "todo" => {
            let app = app.clone();
            let core = app.state::<Arc<Engine>>().inner().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = set_widget(&app, &core, true, true);
            });
        }
        "quit" => {
            if let Some(widget) = app.get_webview_window("todo") {
                persist_placement(&widget, app.state::<Arc<Engine>>().inner());
            }
            app.exit(0);
        }
        _ => {}
    })
    .build(app)?;
    Ok(())
}

pub fn setup(app: &AppHandle, core: Arc<Engine>) {
    core.desktop
        .tray
        .store(build_tray(app).is_ok(), Ordering::Relaxed);
    let app = app.clone();
    let widget_app = app.clone();
    let widget_core = core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if widget_core
            .local()
            .and_then(|s| s.quick_controls())
            .is_ok_and(|s| s.todo_visible)
        {
            let _ = set_widget(&widget_app, &widget_core, true, false);
        }
    });
    tauri::async_runtime::spawn(async move {
        let interval = Duration::from_secs(5);
        let mut cadence =
            tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
        cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            cadence.tick().await;
            dispatch_reminders(&app, &core);
        }
    });
}

pub fn after_restore(app: &AppHandle, core: &Engine) {
    core.desktop.ai_health.store(0, Ordering::Relaxed);
    if let Ok(prefs) = core.local().and_then(|store| store.quick_controls()) {
        if let Some(widget) = app.get_webview_window("todo") {
            let _ = widget.set_always_on_top(prefs.always_on_top);
        }
        let _ = set_widget(app, core, prefs.todo_visible, false);
    }
    let _ = app.emit(QUICK_CHANGED, ());
    let _ = app.emit(TODOS_CHANGED, ());
}

fn dispatch_reminders(app: &AppHandle, core: &Engine) {
    let can_show_in_app = app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
    });
    let due = (|| -> Result<_> {
        let mut store = core.local()?;
        let prefs = store.quick_controls()?;
        if !prefs.interview_reminders || (!prefs.desktop_notifications && !can_show_in_app) {
            return Ok((Vec::new(), prefs.desktop_notifications));
        }
        Ok((
            todo::claim_due(&mut store, now())?,
            prefs.desktop_notifications,
        ))
    })();
    let Ok((due, system_enabled)) = due else {
        return;
    };
    if due.is_empty() {
        return;
    }
    // System notifications omit candidate names, titles and meeting links.
    let body = format!("{} 项面试提醒已到时间，请打开待办查看。", due.len());
    let system_delivered = system_enabled
        && app
            .notification()
            .builder()
            .title("ResumeDesk 面试提醒")
            .body(&body)
            .show()
            .is_ok();
    let notified_in_app = can_show_in_app && app.emit("resumedesk-reminder", due.len()).is_ok();
    let delivered = system_delivered || notified_in_app;
    let system_failed = system_enabled && !system_delivered;
    let old_status = core
        .desktop
        .notification_failed
        .swap(system_failed, Ordering::Relaxed);
    if let Ok(store) = core.local() {
        for reminder in &due {
            let _ = todo::finish_reminder(&store, reminder, now(), delivered);
        }
    }
    if old_status != system_failed {
        let _ = app.emit(QUICK_CHANGED, ());
    }
    let _ = app.emit(TODOS_CHANGED, ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widget_restores_client_size_at_target_dpi_and_clamps_to_the_work_area() {
        let area = PhysicalRect {
            position: PhysicalPosition::new(-1920, -80),
            size: PhysicalSize::new(1920, 1100),
        };
        let saved = Placement {
            x: -40,
            y: 990,
            width: 400.0,
            height: 500.0,
        };
        for (scale, width, height) in [(1.0, 400, 500), (1.25, 500, 625), (1.5, 600, 750)] {
            let frame = PhysicalSize::new(12, 10);
            let (position, size) = widget_bounds(&area, scale, frame, Some(saved));
            assert_eq!(size, PhysicalSize::new(width, height));
            assert_eq!(
                position,
                PhysicalPosition::new(-(width as i32) - 12, 1010 - height as i32),
            );
        }
    }

    #[test]
    fn widget_recovers_when_the_original_monitor_disappears() {
        let area = PhysicalRect {
            position: PhysicalPosition::new(0, 40),
            size: PhysicalSize::new(1280, 720),
        };
        let saved = Placement {
            x: -1900,
            y: 220,
            width: 1150.0,
            height: 100.0,
        };
        let frame = PhysicalSize::new(2, 2);
        assert!(!work_area_contains(&area, saved));
        let (position, size) = widget_bounds(&area, 1.5, frame, Some(saved));
        assert_eq!(position, PhysicalPosition::new(0, 85));
        assert_eq!(size, PhysicalSize::new(1278, 420));
    }

    #[test]
    fn quick_controls_are_shared_and_ai_gate_survives_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(temp.path()).unwrap();
        assert!(require_ai(&store).is_ok());
        let mut controls = store.quick_controls().unwrap();
        controls.ai_enabled = false;
        controls.todo_visible = true;
        controls.desktop_notifications = false;
        store.set_widget_setting("controls", &controls).unwrap();
        assert!(require_ai(&store).is_err());
        drop(store);
        let store = Store::open(temp.path()).unwrap();
        let restored = store.quick_controls().unwrap();
        assert!(restored.todo_visible);
        assert!(!restored.desktop_notifications);
        assert!(require_ai(&store).is_err());
    }
}
