//! Explicit grants and the shared SQLite store used by the server and local CLI.
use std::{collections::BTreeSet, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use rusqlite_migration::{M, Migrations};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

macro_rules! permissions {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum Permission { $(#[serde(rename = $name)] $variant),+ }
        impl Permission {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn name(self) -> &'static str { match self { $(Self::$variant => $name),+ } }
            fn parse(name: &str) -> Result<Self> { match name { $($name => Ok(Self::$variant)),+, _ => bail!("unknown permission") } }
        }
    };
}
permissions! {
    AppsLaunch => "apps.launch", AudioListen => "audio.listen", BroadcastsManage => "broadcasts.manage",
    CameraSend => "camera.send", ClipboardRead => "clipboard.read", ClipboardWrite => "clipboard.write",
    CommandsExecute => "commands.execute", DesktopControl => "desktop.control", DesktopView => "desktop.view",
    DragdropUpload => "dragdrop.upload", FilesBrowse => "files.browse", FilesDownload => "files.download",
    FilesManage => "files.manage", FilesUpload => "files.upload", MicrophoneSend => "microphone.send",
    ServerManage => "server.manage", TokensManage => "tokens.manage",
}

#[derive(Clone, Debug, Serialize)]
pub struct Token {
    pub id: Uuid,
    pub label: String,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
    pub permissions: BTreeSet<Permission>,
}
impl Token {
    pub fn live(&self) -> bool { self.expires_at_ms.is_none_or(|expiry| expiry > now_ms()) }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub label: String,
    pub permissions: BTreeSet<Permission>,
    pub expires_at_ms: Option<i64>,
}
impl Create {
    pub fn admin() -> Self { Self { label: "Admin".into(), permissions: Permission::ALL.iter().copied().collect(), expires_at_ms: None } }
    pub fn validate(&mut self) -> Result<()> {
        self.label = self.label.trim().to_string();
        validate_label(&self.label)?;
        ensure!(self.expires_at_ms.is_none_or(|expiry| expiry > now_ms()), "expiry must be in the future");
        Ok(())
    }
}
#[derive(Serialize)]
pub struct Created { pub token: String, pub metadata: Token }

pub fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64 }
pub fn parse_id(value: &str) -> Result<Uuid> {
    let id = Uuid::parse_str(value).context("invalid token ID")?;
    ensure!(id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122 && id.to_string() == value, "expected a canonical UUIDv4 token ID");
    Ok(id)
}
fn validate_label(label: &str) -> Result<()> {
    ensure!((1..=120).contains(&label.chars().count()) && label.trim() == label && !label.chars().any(char::is_control), "label must contain 1–120 characters without control characters");
    Ok(())
}
fn migrations() -> Migrations<'static> { Migrations::new(vec![M::up(include_str!("../migrations/001_initial.sql"))]) }

#[derive(Clone)]
pub struct Store { connection: Arc<Mutex<Connection>> }
impl Store {
    pub async fn open(path: PathBuf) -> Result<Self> {
        tokio::task::spawn_blocking(move || {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
            let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(&path)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            drop(file);
            let mut connection = Connection::open(path).context("open state database")?;
            connection.busy_timeout(Duration::from_secs(5))?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            connection.pragma_update(None, "synchronous", "FULL")?;
            connection.pragma_update(None, "foreign_keys", "ON")?;
            migrations().to_latest(&mut connection).context("initialize state schema")?;
            let tx = connection.transaction()?;
            read_tokens(&tx, None)?;
            let violations: bool = tx.prepare("PRAGMA foreign_key_check")?.exists([])?;
            ensure!(!violations, "invalid token references");
            tx.commit()?;
            Ok(Self { connection: Arc::new(Mutex::new(connection)) })
        }).await?
    }
    async fn run<T: Send + 'static>(&self, f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static) -> Result<T> {
        let connection = self.connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut db = connection.lock().map_err(|_| anyhow::anyhow!("state database lock poisoned"))?;
            f(&mut db)
        }).await?
    }
    pub async fn create(&self, mut request: Create) -> Result<Created> {
        request.validate()?;
        self.run(move |db| {
            request.validate()?;
            let secret = crate::random_hex(32);
            let digest: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
            let metadata = Token { id: Uuid::new_v4(), label: request.label, created_at_ms: now_ms(), expires_at_ms: request.expires_at_ms, permissions: request.permissions };
            let tx = db.transaction()?;
            tx.execute("INSERT INTO tokens VALUES (?1, ?2, ?3, ?4, ?5)", params![metadata.id.to_string(), digest.as_slice(), metadata.label, metadata.created_at_ms, metadata.expires_at_ms])?;
            for permission in &metadata.permissions {
                tx.execute("INSERT INTO token_permissions VALUES (?1, ?2)", params![metadata.id.to_string(), permission.name()])?;
            }
            tx.commit()?;
            Ok(Created { token: secret, metadata })
        }).await
    }
    pub async fn authenticate(&self, secret: &str) -> Result<Option<Token>> {
        if secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Ok(None); }
        let digest: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
        self.run(move |db| {
            let tx = db.transaction()?;
            let id: Option<String> = tx.query_row("SELECT id FROM tokens WHERE secret_hash = ?1", [digest.as_slice()], |r| r.get(0)).optional()?;
            let token = match id { Some(id) => read_tokens(&tx, Some(&id))?.pop().filter(Token::live), None => None };
            tx.commit()?;
            Ok(token)
        }).await
    }
    pub async fn list(&self) -> Result<Vec<Token>> {
        self.run(|db| { let tx = db.transaction()?; let list = read_tokens(&tx, None)?; tx.commit()?; Ok(list) }).await
    }
    pub async fn revoke(&self, id: Uuid) -> Result<bool> {
        self.run(move |db| {
            let tx = db.transaction()?;
            let deleted = tx.execute("DELETE FROM tokens WHERE id = ?1", [id.to_string()])? != 0;
            tx.commit()?;
            Ok(deleted)
        }).await
    }
}
fn read_tokens(db: &Connection, id: Option<&str>) -> Result<Vec<Token>> {
    let mut query = db.prepare("SELECT id, label, created_at_ms, expires_at_ms, secret_hash FROM tokens WHERE ?1 IS NULL OR id = ?1 ORDER BY created_at_ms, id")?;
    let mut rows = query.query([id])?;
    let mut tokens = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let label: String = row.get(1)?;
        validate_label(&label)?;
        let created_at_ms: i64 = row.get(2)?;
        let expires_at_ms: Option<i64> = row.get(3)?;
        let digest: Vec<u8> = row.get(4)?;
        ensure!(digest.len() == 32 && created_at_ms >= 0 && expires_at_ms.is_none_or(|e| e > created_at_ms), "invalid token record");
        let mut grants = db.prepare("SELECT permission FROM token_permissions WHERE token_id = ?1 ORDER BY permission")?;
        let mut grants = grants.query([&id])?;
        let mut permissions = BTreeSet::new();
        while let Some(row) = grants.next()? {
            permissions.insert(Permission::parse(&row.get::<_, String>(0)?)?);
        }
        tokens.push(Token { id: parse_id(&id)?, label, created_at_ms, expires_at_ms, permissions });
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Database(PathBuf);
    impl Database {
        fn new() -> Self { Self(std::env::temp_dir().join(format!("elsewhere-state-{}", Uuid::new_v4()))) }
        fn path(&self) -> PathBuf { self.0.join("state.sqlite3") }
    }
    impl Drop for Database { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[tokio::test]
    async fn transactional_grants_and_cross_connection_lifecycle() -> Result<()> {
        let fixture = Database::new();
        let first = Store::open(fixture.path()).await?;
        let second = Store::open(fixture.path()).await?;
        assert!(first.list().await?.is_empty());
        let created = first.create(Create::admin()).await?;
        assert_eq!(created.token.len(), 64);
        assert_eq!(second.authenticate(&created.token).await?.unwrap().id, created.metadata.id);
        assert!(second.authenticate(&created.token.to_uppercase()).await?.is_none());
        first.run(|db| {
            db.execute_batch("CREATE TRIGGER reject_grant BEFORE INSERT ON token_permissions BEGIN SELECT RAISE(ABORT, 'blocked'); END;")?;
            Ok(())
        }).await?;
        assert!(second.create(Create::admin()).await.is_err());
        assert_eq!(first.list().await?.len(), 1);
        first.run(|db| { db.execute_batch("DROP TRIGGER reject_grant;")?; Ok(()) }).await?;
        assert!(second.revoke(created.metadata.id).await?);
        assert!(first.authenticate(&created.token).await?.is_none());
        first.run(|db| { assert_eq!(db.query_row("SELECT COUNT(*) FROM token_permissions", [], |r| r.get::<_, i64>(0))?, 0); Ok(()) }).await?;
        let expiring = first.create(Create { label: "Short".into(), permissions: [Permission::DesktopView].into(), expires_at_ms: Some(now_ms() + 1000) }).await?;
        let id = expiring.metadata.id.to_string();
        first.run(move |db| {
            db.execute("UPDATE tokens SET created_at_ms = 0, expires_at_ms = 1 WHERE id = ?1", [id])?;
            Ok(())
        }).await?;
        assert!(second.authenticate(&expiring.token).await?.is_none());
        assert_eq!(Store::open(fixture.path()).await?.list().await?.len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn invalid_state_and_schema_fail_closed() -> Result<()> {
        let fixture = Database::new();
        let store = Store::open(fixture.path()).await?;
        assert!(serde_json::from_str::<Create>(r#"{"label":"Test","permissions":["unknown"]}"#).is_err());
        assert!(store.create(Create { label: " ".into(), permissions: BTreeSet::new(), expires_at_ms: None }).await.is_err());
        assert!(store.create(Create { label: "Past".into(), permissions: BTreeSet::new(), expires_at_ms: Some(1) }).await.is_err());
        let token = store.create(Create::admin()).await?;
        store.run(|db| { db.execute("UPDATE token_permissions SET permission = 'unknown' WHERE permission = 'desktop.view'", [])?; Ok(()) }).await?;
        assert!(store.authenticate(&token.token).await.is_err());
        assert!(Store::open(fixture.path()).await.is_err());
        store.run(|db| { db.execute_batch("PRAGMA user_version = 2147483647;")?; Ok(()) }).await?;
        assert!(Store::open(fixture.path()).await.is_err());
        Ok(())
    }
}
