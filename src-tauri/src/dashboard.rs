use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::{
    model::{Result, message},
    store::Store,
};

const VERSION: i64 = 1;
const DASHBOARD_WIDGETS: &[&str] = &[
    "overview",
    "candidates",
    "jobs",
    "progress",
    "todos",
    "interviews",
    "assistant",
    "controls",
    "knowledge",
];
const TOOL_WIDGETS: &[&str] = &["todos", "knowledge", "interview"];

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    #[default]
    Dashboard,
    Tools,
}

impl Surface {
    fn table(self) -> &'static str {
        match self {
            Self::Dashboard => "dashboard_layout",
            Self::Tools => "tool_hub_layout",
        }
    }

    fn widgets(self) -> &'static [&'static str] {
        match self {
            Self::Dashboard => DASHBOARD_WIDGETS,
            Self::Tools => TOOL_WIDGETS,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    pub width: i64,
    pub height: i64,
    pub visible: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Layout {
    version: i64,
    widgets: Vec<Widget>,
}

fn compatible(surface: Surface, item: &Widget) -> bool {
    surface.widgets().contains(&item.id.as_str())
        && matches!(item.width, 1 | 2 | 4)
        && (1..=3).contains(&item.height)
}

pub fn layout(store: &Store, surface: Surface) -> Result<Option<Layout>> {
    let stored: Option<(i64, String)> = store
        .db
        .query_row(
            &format!("SELECT version,widgets FROM {} WHERE id=1", surface.table()),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((VERSION, raw)) = stored else {
        return Ok(None);
    };
    let Ok(widgets) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Ok(None);
    };
    let mut seen = HashSet::new();
    let widgets = widgets
        .into_iter()
        .filter_map(|raw| serde_json::from_value::<Widget>(raw).ok())
        .filter(|widget| compatible(surface, widget) && seen.insert(widget.id.clone()))
        .collect();
    Ok(Some(Layout {
        version: VERSION,
        widgets,
    }))
}

pub fn save(store: &Store, surface: Surface, layout: Layout) -> Result<()> {
    let mut ids = HashSet::new();
    if layout.version != VERSION
        || layout.widgets.len() > surface.widgets().len()
        || !layout
            .widgets
            .iter()
            .all(|item| compatible(surface, item) && ids.insert(&item.id))
    {
        return Err(message("工作台布局无效，请重新打开编辑。"));
    }
    store.db.execute(
        &format!(
            "INSERT INTO {}(id,version,widgets) VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET version=excluded.version,widgets=excluded.widgets",
            surface.table()
        ),
        rusqlite::params![VERSION, serde_json::to_string(&layout.widgets)?],
    )?;
    Ok(())
}
