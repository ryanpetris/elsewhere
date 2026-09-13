//! UI elements of a window (roles, names, rectangles), read live from the toolkit's AT-SPI tree over the
//! accessibility bus of the D-Bus session this process runs in, so a script can target a button instead of
//! interpreting pixels. Coordinates come back relative to the window's geometry, like the window list.

use anyhow::{Context, Result};
use elsewhere_core::WindowInfo;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{collections::{VecDeque, HashSet}, time::{Duration, Instant}};
use zbus::{Connection, names::BusName, proxy, proxy::CacheProperties, zvariant::OwnedObjectPath};

/// AT-SPI object reference: (bus name, object path).
type Ref = (String, OwnedObjectPath);

const COORD_WINDOW: u32 = 1;
const ROLE_MENU: u32 = 33;
const ROLE_WINDOW: u32 = 69;
const ROLE_DOCUMENT_WEB: u32 = 95;
const STATE_SHOWING: u32 = 25;
const MAX_VISITED: usize = 3000;
const MAX_ELEMENTS: usize = 500;

#[proxy(interface = "org.a11y.Bus", default_service = "org.a11y.Bus", default_path = "/org/a11y/bus")]
trait Launcher {
    fn get_address(&self) -> zbus::Result<String>;
}

#[proxy(interface = "org.a11y.atspi.Accessible", assume_defaults = false)]
trait Accessible {
    fn get_children(&self) -> zbus::Result<Vec<Ref>>;
    fn get_role(&self) -> zbus::Result<u32>;
    fn get_state(&self) -> zbus::Result<Vec<u32>>;
    fn get_interfaces(&self) -> zbus::Result<Vec<String>>;
    #[zbus(property)]
    fn name(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn parent(&self) -> zbus::Result<Ref>;
}

#[proxy(interface = "org.a11y.atspi.Component", assume_defaults = false)]
trait Component {
    fn get_extents(&self, coord_type: u32) -> zbus::Result<(i32, i32, i32, i32)>;
}

#[proxy(interface = "org.a11y.atspi.Application", assume_defaults = false)]
trait Application {
    #[zbus(property)]
    fn toolkit_name(&self) -> zbus::Result<String>;
}

#[proxy(interface = "org.a11y.atspi.Action", assume_defaults = false)]
trait Action {
    #[zbus(property)]
    fn n_actions(&self) -> zbus::Result<i32>;
    fn get_name(&self, index: i32) -> zbus::Result<String>;
    fn do_action(&self, index: i32) -> zbus::Result<bool>;
}

#[proxy(interface = "org.a11y.atspi.EditableText", assume_defaults = false)]
trait EditableText {
    fn set_text_contents(&self, text: &str) -> zbus::Result<bool>;
}

#[proxy(interface = "org.a11y.atspi.Text", assume_defaults = false)]
trait Text {
    fn get_text(&self, start: i32, end: i32) -> zbus::Result<String>;
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Target {
    Node { bus: String, frame: Ref, frame_name: String, root: Ref, object: Ref },
    Decoration(String),
}

impl Target {
    fn same_identity(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Node { bus: a, frame: b, root: c, object: d, .. }, Self::Node { bus: e, frame: f, root: g, object: h, .. }) => (a, b, c, d) == (e, f, g, h),
            (Self::Decoration(a), Self::Decoration(b)) => a == b,
            _ => false,
        }
    }
}

#[derive(Clone, Serialize, JsonSchema)]
pub struct Element {
    /// Opaque reference valid for 30 seconds, within this window and server process.
    pub reference: Option<String>,
    /// Null means the toolkit did not provide the state.
    pub enabled: Option<bool>,
    pub focused: Option<bool>,
    /// Null for controls without a checked state or unavailable state information.
    pub checked: Option<bool>,
    pub editable: Option<bool>,
    /// Advertised action names; null means discovery failed.
    pub actions: Option<Vec<String>>,
    pub bounds_available: bool,
    #[serde(skip)]
    pub(crate) target: Option<Target>,
    pub role: &'static str,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// `level`: `none` (the app isn't on the bus), `app` (on the bus, but no toplevel matches this window),
/// `frame` (the toplevel is there but empty; Chromium without --force-renderer-accessibility), `full`.
#[derive(Serialize, JsonSchema)]
pub struct Page {
    pub level: &'static str,
    pub toolkit: Option<String>,
    pub elements: Vec<Element>,
    /// A bounded or interrupted walk cannot prove selector uniqueness.
    pub truncated: bool,
    /// Accessibility failure, even when compositor decorations remain readable.
    pub unavailable: Option<String>,
    #[serde(skip)]
    pub(crate) connection: Option<Connection>,
    #[serde(skip)]
    pub(crate) windows: Vec<(u64, String)>,
    #[serde(skip)]
    frame: Option<(Ref, String)>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum Selector {
    Reference { reference: String },
    Exact { role: String, name: String },
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ElementAction { pub target: Selector, pub action: String }

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ElementText { pub target: Selector, pub text: String }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Condition { Present, Enabled, Disabled, Checked, Unchecked, Focused, Unfocused }

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ElementWait {
    pub target: Selector,
    pub condition: Condition,
    /// 0 through 10000 milliseconds, including tree reads. Default 2000.
    #[serde(default = "wait_timeout")]
    pub timeout_ms: u64,
}
fn wait_timeout() -> u64 { 2000 }

#[derive(Serialize, JsonSchema)]
pub struct WaitResult { pub matched: bool, pub elapsed_ms: u64, pub attempts: u32, pub element: Option<Element>, pub last_error: Option<WaitError> }

#[derive(Serialize, JsonSchema)]
pub struct WaitError { pub code: &'static str, pub error: String }

#[derive(Clone)]
pub(crate) struct Reference {
    pub window: u64,
    pub pid: Option<u32>,
    pub target: Target,
    element: Element,
    expires: Instant,
}

/// A bounded cache of 30-second references. Reads and waits allocate only when returning a result.
#[derive(Default)]
pub(crate) struct References(VecDeque<(String, Reference)>);
impl References {
    pub fn get(&mut self, id: &str) -> Option<Reference> {
        let now = Instant::now();
        self.0.retain(|(_, r)| r.expires > now);
        self.0.iter().find(|(key, _)| key == id).map(|(_, r)| r.clone())
    }
    pub fn issue(&mut self, window: &WindowInfo, element: &mut Element) {
        let Some(target) = &element.target else { return; };
        let now = Instant::now();
        self.0.retain(|(_, r)| r.expires > now);
        let entry = self.0.iter().position(|(_, r)| r.window == window.id && r.pid == window.pid && r.target.same_identity(target));
        let id = match entry {
            Some(index) => self.0.remove(index).unwrap().0,
            None => uuid::Uuid::new_v4().to_string(),
        };
        if self.0.len() >= 4096 { self.0.pop_front(); }
        self.0.push_back((id.clone(), Reference { window: window.id, pid: window.pid, target: target.clone(), element: element.clone(), expires: now + Duration::from_secs(30) }));
        element.reference = Some(id);
    }
}

pub(crate) fn error(code: &'static str, message: impl Into<String>) -> crate::api::ApiError {
    crate::api::ApiError::Element { code, message: message.into() }
}

pub(crate) fn select(page: &Page, selector: &Selector, reference: Option<&Reference>) -> Result<Element, crate::api::ApiError> {
    let decoration = reference.is_some_and(|r| matches!(r.target, Target::Decoration(_))) || matches!(selector, Selector::Exact { role, .. } if role == "push button");
    if !decoration && page.level == "ambiguous" { return Err(error("ambiguous_window", "multiple accessibility windows match this desktop window")); }
    if !decoration && reference.is_none() && page.truncated { return Err(error("incomplete_tree", "the accessibility walk is incomplete; uniqueness cannot be established")); }
    if !decoration {
        if let Some(why) = &page.unavailable { return Err(error("bus_unavailable", why.clone())); }
        if page.level == "none" { return Err(error("unsupported", "the application is not on the accessibility bus")); }
        if page.level == "app" { return Err(error("window_unavailable", "no accessibility window matches this desktop window")); }
    }
    let mut matches = page.elements.iter().filter(|element| match selector {
        Selector::Reference { .. } => reference.is_some_and(|r| element.target.as_ref().is_some_and(|target| target.same_identity(&r.target))),
        Selector::Exact { role, name } => element.role == role && element.name == *name,
    });
    let Some(element) = matches.next() else {
        if page.truncated && let Some(reference) = reference
            && let Target::Node { bus, frame, root, .. } = &reference.target
            && root == frame
            && let Some((live_frame, name)) = &page.frame
            && frame == live_frame
            && page.connection.as_ref().is_some_and(|conn| conn.server_guid().to_string() == *bus) {
            let mut element = reference.element.clone();
            if let Some(Target::Node { frame_name, .. }) = &mut element.target { *frame_name = name.clone(); }
            element.bounds_available = false;
            (element.x, element.y, element.w, element.h) = (0, 0, 0, 0);
            return Ok(element);
        }
        return Err(error(if reference.is_some() { "stale" } else { "missing" }, "no matching live element"));
    };
    if matches.next().is_some() { return Err(error("ambiguous", "more than one element matches the exact role and name")); }
    if element.target.is_none() { return Err(error("unsupported", "element has no unambiguous semantic ownership")); }
    Ok(element.clone())
}

impl Condition {
    pub(crate) fn matches(self, element: &Element) -> Result<bool, crate::api::ApiError> {
        let (value, expected) = match self {
            Self::Present => return Ok(true),
            Self::Enabled => (element.enabled, true), Self::Disabled => (element.enabled, false),
            Self::Checked => (element.checked, true), Self::Unchecked => (element.checked, false),
            Self::Focused => (element.focused, true), Self::Unfocused => (element.focused, false),
        };
        value.map(|v| v == expected).ok_or_else(|| error("state_unavailable", "the toolkit does not expose the requested state"))
    }
}

async fn action_names(conn: &Connection, object: &Ref) -> Result<Vec<String>> {
    let action = proxy::<ActionProxy>(conn, object).await?;
    let count = action.n_actions().await?;
    anyhow::ensure!((0..=32).contains(&count), "action count exceeds 32");
    let mut names = Vec::with_capacity(count as usize);
    for index in 0..count { names.push(action.get_name(index).await?); }
    Ok(names)
}

/// Recheck ownership and capabilities on the same live bus before dispatch.
pub(crate) async fn refresh(conn: &Connection, element: &Element) -> Result<Element, crate::api::ApiError> {
    let Some(Target::Node { bus, frame, frame_name, root, object }) = &element.target else { return Err(error("unsupported", "no toolkit target")); };
    if *bus != conn.server_guid().to_string() || !object.0.starts_with(':') || !frame.0.starts_with(':') {
        return Err(error("stale", "target has no stable live bus identity"));
    }
    let frame_acc = proxy::<AccessibleProxy>(conn, frame).await.map_err(|e| error("stale", e.to_string()))?;
    if frame_acc.name().await.map_err(|e| error("stale", e.to_string()))? != *frame_name {
        return Err(error("stale", "accessibility window title changed during the operation"));
    }
    if root != frame {
        let popup = proxy::<AccessibleProxy>(conn, root).await.map_err(|e| error("stale", e.to_string()))?;
        if popup.get_role().await.map_err(|e| error("stale", e.to_string()))? != ROLE_WINDOW
            || !state_bit(&popup.get_state().await.map_err(|e| error("stale", e.to_string()))?, STATE_SHOWING)
            || popup.parent().await.map_err(|e| error("stale", e.to_string()))? != frame_acc.parent().await.map_err(|e| error("stale", e.to_string()))? {
            return Err(error("stale", "popup no longer belongs to the live application window"));
        }
    }
    let mut ancestor = object.clone();
    let mut owned = false;
    for _ in 0..MAX_VISITED {
        if ancestor == *root { owned = true; break; }
        if is_null(&ancestor) { return Err(error("stale", "target no longer belongs to the requested accessibility window")); }
        ancestor = proxy::<AccessibleProxy>(conn, &ancestor).await.map_err(|e| error("stale", e.to_string()))?.parent().await.map_err(|e| error("stale", e.to_string()))?;
    }
    if !owned { return Err(error("incomplete_tree", "target ancestry did not reach the requested window within the traversal bound")); }
    let acc = proxy::<AccessibleProxy>(conn, object).await.map_err(|e| error("stale", e.to_string()))?;
    let state = acc.get_state().await.map_err(|e| error("state_unavailable", e.to_string()))?;
    if state.is_empty() { return Err(error("state_unavailable", "target state is unavailable")); }
    if state_bit(&state, 6) || !state_bit(&state, STATE_SHOWING) { return Err(error("stale", "target is defunct or no longer showing")); }
    let interfaces = acc.get_interfaces().await.map_err(|e| error("state_unavailable", e.to_string()))?;
    let mut live = element.clone();
    live.name = acc.name().await.map_err(|e| error("stale", e.to_string()))?;
    live.role = role_name(acc.get_role().await.map_err(|e| error("stale", e.to_string()))?).ok_or_else(|| error("stale", "target role is no longer supported"))?;
    if live.name != element.name || live.role != element.role { return Err(error("stale", "target role or name changed during revalidation")); }
    live.enabled = Some(state_bit(&state, 8) && state_bit(&state, 24));
    live.focused = Some(state_bit(&state, 12));
    live.checked = element.checked.map(|_| state_bit(&state, 4));
    live.editable = Some(interfaces.iter().any(|i| i == "org.a11y.atspi.EditableText") && state_bit(&state, 7));
    live.actions = if interfaces.iter().any(|i| i == "org.a11y.atspi.Action") {
        Some(action_names(conn, object).await.map_err(|e| error("state_unavailable", e.to_string()))?)
    } else { Some(vec![]) };
    Ok(live)
}

/// Invoke once; a transport error or timeout leaves the mutation outcome uncertain.
pub(crate) async fn perform(conn: &Connection, key: &crate::Key, element: &Element, action: Option<&str>, text: Option<&str>, dispatched: &mut bool) -> Result<(), crate::api::ApiError> {
    let Some(Target::Node { object, .. }) = &element.target else { return Err(error("unsupported", "no toolkit action target")); };
    let result = if let Some(text) = text {
        let proxy = proxy::<EditableTextProxy>(conn, object).await.map_err(|e| error("bus_unavailable", e.to_string()))?;
        key.require(crate::tokens::Permission::DesktopControl)?;
        *dispatched = true;
        proxy.set_text_contents(text).await
    } else {
        let actions = element.actions.as_ref().ok_or_else(|| error("state_unavailable", "action discovery is unavailable"))?;
        let action = action.unwrap_or_default();
        let indices: Vec<_> = actions.iter().enumerate().filter(|(_, name)| name.as_str() == action).map(|(i, _)| i).collect();
        if indices.len() != 1 { return Err(error("unsupported", "action must match exactly one advertised action name")); }
        let proxy = proxy::<ActionProxy>(conn, object).await.map_err(|e| error("bus_unavailable", e.to_string()))?;
        let index = indices[0] as i32;
        if proxy.get_name(index).await.map_err(|e| error("stale", e.to_string()))? != action { return Err(error("stale", "advertised action changed before dispatch")); }
        key.require(crate::tokens::Permission::DesktopControl)?;
        *dispatched = true;
        proxy.do_action(index).await
    };
    match result {
        Ok(true) => {
            if let Some(expected) = text.filter(|_| element.role != "password") {
                let reader = proxy::<TextProxy>(conn, object).await.map_err(|e| error("uncertain", format!("text was accepted but cannot be verified: {e}; do not retry automatically")))?;
                loop {
                    let actual = reader.get_text(0, expected.encode_utf16().count() as i32 + 1).await.map_err(|e| error("uncertain", format!("text was accepted but cannot be verified: {e}; do not retry automatically")))?;
                    if actual == expected { break; }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            Ok(())
        }, Ok(false) => Err(error("rejected", "the toolkit rejected the operation")),
        Err(e) => Err(error("uncertain", format!("the dispatched operation has no confirmed result: {e}; do not retry automatically"))),
    }
}

/// The window's elements: the application's from its accessibility tree, then the compositor's own
/// decorations (title bar and buttons, above the geometry at negative `y`) when it draws them.
/// `scale` is the output scale: Chromium reports its web content in device pixels (its own UI in logical ones).
pub async fn elements(win: &WindowInfo, scale: f64, lone_window: bool) -> Result<Page> {
    let mut page = match app_elements(win, scale, lone_window).await {
        Ok(page) => page,
        // no bus at all: a decorated window still has its bar to offer
        Err(e) if win.decoration > 0 => {
            tracing::debug!("elements of window {}: {e:#}", win.id);
            Page { level: "none", toolkit: None, elements: vec![], truncated: false, unavailable: Some(format!("{e:#}")), connection: None, windows: vec![], frame: None }
        }
        Err(e) => return Err(e),
    };
    if win.decoration > 0 {
        use elsewhere_core::decoration::{BAR, BUTTON, buttons};
        page.elements.push(Element { reference: None, enabled: Some(true), focused: Some(win.focused), checked: None, editable: Some(false), actions: Some(vec![]), bounds_available: true, target: None, role: "title bar", name: win.title.clone(), x: 0, y: -BAR, w: win.w, h: BAR });
        page.elements.extend(buttons(win.w).map(|(b, x)| Element { reference: None, enabled: Some(true), focused: Some(false), checked: None, editable: Some(false), actions: Some(vec!["activate".into()]), bounds_available: true, target: Some(Target::Decoration(b.name(win.maximized).into())), role: "push button", name: b.name(win.maximized).into(), x, y: -BAR, w: BUTTON, h: BAR }));
    }
    Ok(page)
}

async fn app_elements(win: &WindowInfo, scale: f64, lone_window: bool) -> Result<Page> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    // ponytail: a fresh bus connection per request; cache one if requests ever get frequent
    let conn = a11y_bus().await?;
    let dbus = zbus::fdo::DBusProxy::new(&conn).await?;
    let registry = ("org.a11y.atspi.Registry".to_string(), OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root")?);
    let apps = proxy::<AccessibleProxy>(&conn, &registry).await?.get_children().await.context("accessibility registry not running")?;
    let none = Page { level: "none", toolkit: None, elements: vec![], truncated: false, unavailable: None, connection: Some(conn.clone()), windows: vec![], frame: None };
    let Some(pid) = win.pid else { return Ok(none) };
    if apps.len() > 256 { anyhow::bail!("accessibility registry exceeds 256 applications"); }
    let mut matching = Vec::new();
    for r in apps {
        let name = BusName::try_from(r.0.as_str())?;
        match dbus.get_connection_unix_process_id(name).await {
            Ok(owner) if owner == pid => matching.push(r),
            Ok(_) | Err(zbus::fdo::Error::NameHasNoOwner(_)) => {},
            Err(error) => return Err(error.into()),
        }
    }
    if matching.len() > 1 { return Ok(Page { level: "ambiguous", ..none }); }
    let Some(app) = matching.pop() else { return Ok(none) };
    let toolkit = proxy::<ApplicationProxy>(&conn, &app).await?.toolkit_name().await.ok();
    // The application's toplevels: real windows (frame, dialog) and, in GTK 3, one borderless `window`
    // per open menu. The frame is the one named like the window; a lone toplevel needs no match.
    let mut tops = Vec::new();
    for r in proxy::<AccessibleProxy>(&conn, &app).await?.get_children().await?.into_iter().filter(|r| !is_null(r)) {
        let acc = proxy::<AccessibleProxy>(&conn, &r).await?;
        if tops.len() >= 256 { anyhow::bail!("accessibility application exceeds 256 windows"); }
        tops.push((r, acc.get_role().await? == ROLE_WINDOW, acc.name().await?));
    }
    let mut frames: Vec<&Ref> = tops.iter().filter(|t| !t.1).map(|t| &t.0).collect();
    if frames.is_empty() {
        frames = tops.iter().map(|t| &t.0).collect();
    }
    let matches: Vec<_> = frames.iter().filter(|r| tops.iter().any(|t| &t.0 == **r && t.2 == win.title)).collect();
    let frame = if matches.len() == 1 { Some((**matches[0]).clone()) }
        else if matches.len() > 1 { return Ok(Page { level: "ambiguous", toolkit, ..none }); }
        else if lone_window && frames.len() == 1 { Some(frames[0].clone()) } else { None };
    let Some(frame) = frame else { return Ok(Page { level: "app", toolkit, ..none }) };
    let frame_name = tops.iter().find(|t| t.0 == frame).unwrap().2.clone();
    let (dx, dy) = origin(proxy::<ComponentProxy>(&conn, &frame).await?.get_extents(COORD_WINDOW).await?, win);
    let children = proxy::<AccessibleProxy>(&conn, &frame).await?.get_children().await?;
    let level = if children.is_empty() && win.popups.is_empty() { "frame" } else { "full" };
    // menu windows are walked only while this window has popups open; their nodes count only once placed
    let mut menus = Vec::new();
    for top in tops.iter().filter(|t| t.1 && t.0 != frame && !win.popups.is_empty()) {
        if state_bit(&proxy::<AccessibleProxy>(&conn, &top.0).await?.get_state().await?, STATE_SHOWING) { menus.push(top.0.clone()); }
    }
    // A separate popup root is attributable only with one live application window and popup.
    let popup_owned = lone_window && frames.len() == 1 && menus.len() == 1 && win.popups.len() == 1;

    // depth-first in document order; a subtree that isn't showing is skipped whole. The flag marks
    // Chromium web content, whose extents are in device pixels (everything else is logical). The shift
    // places an open menu: toolkits report its items relative to the menu's own popup surface, so a menu
    // node with the size of an open popup gets that popup's position for itself and its subtree.
    let chromium = toolkit.as_deref() == Some("Chromium");
    let mut used = vec![false; win.popups.len()];
    // (node, in Chromium web content, shift onto a popup, inside a menu window)
    let mut stack: Vec<(Ref, bool, Option<(i32, i32)>, bool, Ref)> = menus.into_iter().rev().map(|r| (r.clone(), false, None, true, r)).collect();
    stack.extend(children.into_iter().rev().map(|r| (r, false, None, false, frame.clone())));
    let mut out = Vec::new();
    let mut visited = 0;
    let mut seen = HashSet::new();
    let mut truncated = stack.len() > MAX_VISITED;
    stack.truncate(MAX_VISITED);
    while let Some((r, device, mut shift, in_menu, root)) = stack.pop() {
        visited += 1;
        if visited > MAX_VISITED || out.len() >= MAX_ELEMENTS {
            truncated = true;
            break;
        }
        if is_null(&r) || !seen.insert(r.clone()) {
            continue;
        }
        let visit = async {
            let acc = proxy::<AccessibleProxy>(&conn, &r).await?;
            let state = acc.get_state().await.ok().filter(|s| !s.is_empty());
            if state.as_ref().is_some_and(|s| !state_bit(s, STATE_SHOWING)) {
                return Ok::<(), anyhow::Error>(());
            }
            let role = match acc.get_role().await { Ok(role) => role, Err(_) => { truncated = true; 0 } };
            let s = if device { scale } else { 1.0 };
            let ext = extents(&conn, &r, s).await.ok().filter(|e| e.2 > 0 && e.3 > 0);
            let mut matched = false;
            if let Some(name) = role_name(role) {
                let (x, y, w, h) = ext.unwrap_or_default();
                // a menu in its own window (context menu): the menu node itself has the popup's size
                if role == ROLE_MENU && let Some(i) = win.popups.iter().enumerate().position(|(i, p)| (p.2, p.3) == (w, h) && !used[i]) {
                    used[i] = true;
                    shift = Some((win.popups[i].0 - x, win.popups[i].1 - y));
                    matched = true;
                }
                let (x, y) = match shift {
                    Some((sx, sy)) => (x + sx, y + sy),
                    None => (x - dx, y - dy),
                };
                if shift.is_some() || !in_menu {
                    let label = match acc.name().await { Ok(name) => name, Err(_) => { truncated = true; String::new() } };
                    let interfaces = acc.get_interfaces().await.ok();
                    let editable = interfaces.as_ref().and_then(|i| state.as_ref().map(|s| i.iter().any(|i| i == "org.a11y.atspi.EditableText") && state_bit(s, 7)));
                    let actions = match interfaces.as_ref() {
                        Some(i) if i.iter().any(|i| i == "org.a11y.atspi.Action") => action_names(&conn, &r).await.ok(),
                        Some(_) => Some(vec![]), None => None,
                    };
                    out.push(Element { reference: None, enabled: state.as_ref().map(|s| state_bit(s, 8) && state_bit(s, 24)), focused: state.as_ref().map(|s| state_bit(s, 12)),
                        checked: state.as_ref().filter(|s| state_bit(s, 41) || matches!(role, 7 | 44 | 62 | 130)).map(|s| state_bit(s, 4)), editable, actions, bounds_available: ext.is_some(),
                        target: (!in_menu || popup_owned).then(|| Target::Node { bus: conn.server_guid().to_string(), frame: frame.clone(), frame_name: frame_name.clone(), root: root.clone(), object: r.clone() }), role: name, name: label, x, y, w, h });
                }
            }
            if let Ok(children) = acc.get_children().await {
                let mut child_shift = shift;
                // a menubar menu: GTK 3 hangs the items straight off the menubar item, in the coordinates of the
                // items' popup, so they fall outside the item; as a group they have the popup's width and about
                // its height
                if role == ROLE_MENU && !matched && let Some((mx, my, mw, mh)) = ext {
                    let mut union: Option<(i32, i32, i32, i32)> = None; // x0, y0, x1, y1
                    for c in &children {
                        if let Ok((cx, cy, cw, ch)) = extents(&conn, c, s).await && cw > 0 && ch > 0 && cx.abs() < 1 << 20 && cy.abs() < 1 << 20 {
                            union = Some(union.map_or((cx, cy, cx + cw, cy + ch), |u| (u.0.min(cx), u.1.min(cy), u.2.max(cx + cw), u.3.max(cy + ch))));
                        }
                    }
                    if let Some((x0, y0, x1, y1)) = union
                        && !(x0 >= mx && y0 >= my && x1 <= mx + mw && y1 <= my + mh)
                        && let Some(i) = win.popups.iter().enumerate().position(|(i, p)| !used[i] && p.2 == x1 - x0 && (0..=16).contains(&(p.3 - (y1 - y0))))
                    {
                        used[i] = true;
                        let p = win.popups[i];
                        child_shift = Some((p.0 - x0, p.1 + (p.3 - (y1 - y0)) / 2 - y0));
                    }
                }
                let device = device || (chromium && role == ROLE_DOCUMENT_WEB);
                let remaining = MAX_VISITED.saturating_sub(visited + stack.len());
                if children.len() > remaining { truncated = true; }
                stack.extend(children.into_iter().take(remaining).rev().map(|r| (r, device, child_shift, in_menu, root.clone())));
            } else { truncated = true; }
            Ok::<(), anyhow::Error>(())
        };
        match tokio::time::timeout_at(deadline, visit).await {
            Ok(result) => result?,
            Err(_) => { truncated = true; break; },
        }
    }
    Ok(Page { level, toolkit, elements: out, truncated, unavailable: None, connection: Some(conn), windows: vec![], frame: Some((frame, frame_name)) })
}

/// Toolkits disagree on what "window coordinates" are relative to: GTK 4 uses the xdg geometry, GTK 3 and
/// Chromium the whole surface including the client-side shadow, and Firefox the surface while reporting
/// its frame at the geometry's position. A geometry-sized frame is the origin itself; otherwise the surface is.
fn origin((fx, fy, fw, fh): (i32, i32, i32, i32), win: &WindowInfo) -> (i32, i32) {
    if (fw, fh) == (win.w, win.h) { (fx, fy) } else { (win.geo_x, win.geo_y) }
}

/// The roles a script would target; containers and plain text are left out.
fn role_name(role: u32) -> Option<&'static str> {
    Some(match role {
        43 | 129 => "button",
        62 => "toggle",
        130 => "switch",
        7 => "checkbox",
        44 => "radio",
        88 => "link",
        79 => "entry",
        61 => "text",
        40 => "password",
        11 => "combobox",
        33 => "menu",
        35 | 8 | 45 => "menuitem",
        37 => "tab",
        51 => "slider",
        52 => "spinbutton",
        32 => "listitem",
        91 => "treeitem",
        48 => "scrollbar",
        83 => "heading",
        _ => return None,
    })
}

fn state_bit(state: &[u32], bit: u32) -> bool { state.get((bit / 32) as usize).is_some_and(|word| word & (1 << (bit % 32)) != 0) }

fn is_null(r: &Ref) -> bool {
    r.0.is_empty() || r.1.as_str().ends_with("/null")
}

/// `AT_SPI_BUS_ADDRESS`, else the session bus tells us where the accessibility bus is.
async fn a11y_bus() -> Result<Connection> {
    let addr = match std::env::var("AT_SPI_BUS_ADDRESS") {
        Ok(a) if !a.is_empty() => a,
        _ => {
            let session = Connection::session().await.context("no D-Bus session")?;
            LauncherProxy::new(&session).await?.get_address().await.context("no accessibility bus on the session bus")?
        }
    };
    zbus::connection::Builder::address(addr.as_str())?.build().await.context("accessibility bus")
}

/// Window-relative extents in logical pixels (`scale` > 1 for Chromium web content, which reports device pixels).
async fn extents(conn: &Connection, r: &Ref, scale: f64) -> Result<(i32, i32, i32, i32)> {
    let (x, y, w, h) = proxy::<ComponentProxy>(conn, r).await?.get_extents(COORD_WINDOW).await?;
    let px = |v: i32| (v as f64 / scale).round() as i32;
    Ok((px(x), px(y), px(w), px(h)))
}

/// A proxy for one object; no property cache, so hundreds of short-lived proxies don't each subscribe to signals.
async fn proxy<P: zbus::proxy::ProxyImpl<'static> + zbus::proxy::Defaults + From<zbus::Proxy<'static>>>(conn: &Connection, r: &Ref) -> Result<P> {
    Ok(zbus::proxy::Builder::<P>::new(conn).destination(r.0.clone())?.path(r.1.clone())?.cache_properties(CacheProperties::No).build().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(w: i32, h: i32, geo_x: i32, geo_y: i32) -> WindowInfo {
        WindowInfo {
            workspace: 1,
            id: 1, title: String::new(), app_id: String::new(), x11: false, pid: None,
            icon: None, content: None,
            x: 0, y: 0, w, h, geo_x, geo_y, popups: vec![], decoration: 0, z: Some(0), maximized: false, fullscreen: false, minimized: false, focused: true, updated_ms: 0, content_revision: 0,
        }
    }

    #[test]
    fn semantic_selection_and_reference_bounds() {
        let window = win(100, 100, 0, 0);
        let mut element = Element {
            reference: None, enabled: Some(false), focused: None, checked: None, editable: Some(false), actions: Some(vec!["activate".into()]), bounds_available: true,
            target: Some(Target::Decoration("Save".into())), role: "button", name: "Save".into(), x: 0, y: 0, w: 10, h: 10,
        };
        assert!(Condition::Disabled.matches(&element).unwrap());
        assert!(matches!(Condition::Focused.matches(&element), Err(crate::api::ApiError::Element { code: "state_unavailable", .. })));
        let mut refs = References::default();
        refs.issue(&window, &mut element);
        let first = element.reference.clone().unwrap();
        let reference = refs.get(&first).unwrap();
        let mut other = element.clone();
        other.target = Some(Target::Decoration("Other".into()));
        let mut page = Page { level: "full", toolkit: None, elements: vec![element.clone(), other], truncated: false, unavailable: None, connection: None, windows: vec![], frame: None };
        let exact = Selector::Exact { role: "button".into(), name: "Save".into() };
        assert!(matches!(select(&page, &exact, None), Err(crate::api::ApiError::Element { code: "ambiguous", .. })));
        assert!(select(&page, &Selector::Reference { reference: first.clone() }, Some(&reference)).is_ok());
        page.elements.pop();
        page.truncated = true;
        assert!(matches!(select(&page, &exact, None), Err(crate::api::ApiError::Element { code: "incomplete_tree", .. })));
        assert!(serde_json::from_value::<Selector>(serde_json::json!({"reference":"x", "role":"button", "name":"Save"})).is_err());
        refs.issue(&window, &mut element);
        assert_eq!(refs.0.len(), 1);
        for i in 0..4096 { element.target = Some(Target::Decoration(i.to_string())); refs.issue(&window, &mut element); }
        assert_eq!(refs.0.len(), 4096);
        assert!(refs.get(&first).is_none());
        let last = element.reference.unwrap();
        assert!(refs.get(&last).is_some());
        refs.0.back_mut().unwrap().1.expires = Instant::now() - Duration::from_secs(1);
        assert!(refs.get(&last).is_none());
        let (recent_id, recent) = refs.0.front().unwrap().clone();
        let mut recent = recent.element;
        refs.issue(&window, &mut recent);
        for name in ["new target one", "new target two"] { recent.target = Some(Target::Decoration(name.into())); refs.issue(&window, &mut recent); }
        assert!(refs.get(&recent_id).is_some(), "recently returned references survive capacity eviction");
        assert_eq!(refs.0.len(), 4096);
    }

    /// Frame extents as measured from real toolkits, all with a 700×520 (or given) geometry.
    #[test]
    fn origin_per_toolkit() {
        assert_eq!(origin((0, 0, 700, 520), &win(700, 520, 0, 0)), (0, 0)); // GTK 4: frame == geometry
        assert_eq!(origin((0, 0, 952, 799), &win(900, 747, 26, 23)), (26, 23)); // GTK 3: frame == surface
        assert_eq!(origin((0, 0, 945, 1060), &win(921, 1035, 12, 10)), (12, 10)); // Chromium: frame == surface
        assert_eq!(origin((26, 23, 1280, 972), &win(1280, 972, 26, 23)), (26, 23)); // Firefox: geometry-sized frame at the offset
    }
}
