use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{fs, thread};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::Emitter;

/// Build a `Command` that never flashes a console window on Windows.
///
/// `std::process::Command` on Windows spawns a visible `conhost`/cmd window
/// for every child process unless `CREATE_NO_WINDOW` is set — which is why
/// running git, php, node, etc. popped up windows. On other platforms this is
/// just `Command::new`.
fn win_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

// ===========================================================================
// Filesystem (explorer)
// ===========================================================================

/// A single entry inside a directory listing.
#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

fn to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// List the immediate children of a directory. Directories are sorted before
/// files, each group alphabetically (case-insensitive) — the explorer expands
/// folders lazily by calling this again on the chosen path.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = Vec::new();
    let read = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        entries.push(Entry {
            name,
            path: to_string(&item.path()),
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a text file. Returns an error for binary/non-UTF-8 content so the
/// frontend can show a friendly message instead of garbage.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Read any file as base64 (used to display images, etc.).
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64_encode(&bytes))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("A file or folder already exists at that path".into());
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("A file or folder already exists at that path".into());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("The target name is already taken".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Return the file name component of a path (used for tab labels / titles).
#[tauri::command]
fn base_name(path: String) -> String {
    PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(path)
}

// ===========================================================================
// SQLite — browse and edit .db files, run ad-hoc queries
// ===========================================================================

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;

#[derive(Serialize)]
struct TableData {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    rowids: Vec<i64>,
    editable: bool,
    truncated: bool,
}

#[derive(Serialize)]
struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    affected: Option<usize>,
    truncated: bool,
}

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn vref_to_json(v: ValueRef) -> serde_json::Value {
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::json!(i),
        ValueRef::Real(f) => serde_json::json!(f),
        ValueRef::Text(t) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::Value::String(format!("[blob {} bytes]", b.len())),
    }
}

fn json_to_sql(v: &serde_json::Value) -> SqlValue {
    match v {
        serde_json::Value::Null => SqlValue::Null,
        serde_json::Value::Bool(b) => SqlValue::Integer(*b as i64),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

#[tauri::command]
fn sqlite_tables(path: String) -> Result<Vec<String>, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') \
             AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names)
}

#[tauri::command]
fn sqlite_table(path: String, table: String) -> Result<TableData, String> {
    const LIMIT: usize = 2000;
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;

    // Prefer selecting the implicit rowid so edits can target individual rows;
    // WITHOUT ROWID tables and views reject that, so fall back to a plain read
    // and mark the result non-editable.
    let with_rowid = format!(
        "SELECT rowid AS __rid__, * FROM {} LIMIT {}",
        quote_ident(&table),
        LIMIT + 1
    );
    let plain = format!("SELECT * FROM {} LIMIT {}", quote_ident(&table), LIMIT + 1);
    let (sql, editable) = match conn.prepare(&with_rowid) {
        Ok(_) => (with_rowid, true),
        Err(_) => (plain, false),
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let all_cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let data_start = if editable { 1 } else { 0 };
    let columns: Vec<String> = all_cols[data_start..].to_vec();
    let ncol = all_cols.len();

    let mut rows = Vec::new();
    let mut rowids = Vec::new();
    let mut truncated = false;
    let mut q = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        if rows.len() >= LIMIT {
            truncated = true;
            break;
        }
        if editable {
            rowids.push(r.get::<_, i64>(0).unwrap_or(-1));
        }
        let mut vals = Vec::with_capacity(ncol - data_start);
        for i in data_start..ncol {
            vals.push(vref_to_json(r.get_ref(i).map_err(|e| e.to_string())?));
        }
        rows.push(vals);
    }

    Ok(TableData {
        columns,
        rows,
        rowids,
        editable,
        truncated,
    })
}

#[tauri::command]
fn sqlite_query(path: String, sql: String) -> Result<QueryResult, String> {
    const LIMIT: usize = 5000;
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let ncol = stmt.column_count();

    // Statements that return no columns (INSERT/UPDATE/DELETE/CREATE/…) are
    // executed for their side effect and report the affected row count.
    if ncol == 0 {
        let n = stmt.execute([]).map_err(|e| e.to_string())?;
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected: Some(n),
            truncated: false,
        });
    }

    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut q = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        if rows.len() >= LIMIT {
            truncated = true;
            break;
        }
        let mut vals = Vec::with_capacity(ncol);
        for i in 0..ncol {
            vals.push(vref_to_json(r.get_ref(i).map_err(|e| e.to_string())?));
        }
        rows.push(vals);
    }

    Ok(QueryResult {
        columns,
        rows,
        affected: None,
        truncated,
    })
}

#[tauri::command]
fn sqlite_update_cell(
    path: String,
    table: String,
    rowid: i64,
    column: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let q = format!(
        "UPDATE {} SET {} = ?1 WHERE rowid = ?2",
        quote_ident(&table),
        quote_ident(&column)
    );
    conn.execute(&q, rusqlite::params![json_to_sql(&value), rowid])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn sqlite_insert_row(path: String, table: String) -> Result<i64, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute(
        &format!("INSERT INTO {} DEFAULT VALUES", quote_ident(&table)),
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn sqlite_delete_row(path: String, table: String, rowid: i64) -> Result<(), String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute(
        &format!("DELETE FROM {} WHERE rowid = ?1", quote_ident(&table)),
        rusqlite::params![rowid],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ===========================================================================
// Git — source control via the system `git` binary (any remote: GitHub,
// GitLab, self-hosted — they are all just remote URLs).
// ===========================================================================

#[derive(Serialize)]
struct GitFile {
    path: String,
    status: String,
    staged: bool,
}

#[derive(Serialize)]
struct GitStatus {
    is_repo: bool,
    branch: String,
    files: Vec<GitFile>,
    remotes: Vec<String>,
    ahead: i32,
    behind: i32,
    ignored: Vec<String>,
}

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = win_cmd("git")
        .current_dir(cwd)
        // Never block waiting for an interactive credential prompt (which has
        // no console to show in, so it would hang forever).
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
fn git_status(cwd: String) -> Result<GitStatus, String> {
    let inside = win_cmd("git")
        .current_dir(&cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|e| e.to_string())?;
    if !inside.status.success() {
        return Ok(GitStatus {
            is_repo: false,
            branch: String::new(),
            files: vec![],
            remotes: vec![],
            ahead: 0,
            behind: 0,
            ignored: vec![],
        });
    }

    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    let porcelain = run_git(
        &cwd,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let x = &line[0..1];
        let y = &line[1..2];
        let path = line[3..].to_string();
        let staged = x != " " && x != "?";
        files.push(GitFile {
            path,
            status: format!("{}{}", x, y).trim().to_string(),
            staged,
        });
    }

    let remotes: Vec<String> = run_git(&cwd, &["remote"])
        .unwrap_or_default()
        .lines()
        .map(|s| s.to_string())
        .collect();

    let (mut ahead, mut behind) = (0, 0);
    if let Ok(s) = run_git(
        &cwd,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ) {
        let parts: Vec<&str> = s.split_whitespace().collect();
        if parts.len() == 2 {
            ahead = parts[0].parse().unwrap_or(0);
            behind = parts[1].parse().unwrap_or(0);
        }
    }

    // top-level ignored entries (files and directories, dirs end with '/')
    let ignored: Vec<String> = run_git(
        &cwd,
        &["status", "--porcelain=v1", "--ignored", "--untracked-files=no"],
    )
    .unwrap_or_default()
    .lines()
    .filter(|l| l.starts_with("!!"))
    .map(|l| l[3..].trim().to_string())
    .collect();

    Ok(GitStatus {
        is_repo: true,
        branch,
        files,
        remotes,
        ahead,
        behind,
        ignored,
    })
}

#[tauri::command]
fn git_init(cwd: String) -> Result<String, String> {
    run_git(&cwd, &["init"])
}

/// Clone `url` into directory `dest`; returns the path of the cloned folder.
#[tauri::command]
fn git_clone(url: String, dest: String) -> Result<String, String> {
    let out = win_cmd("git")
        .current_dir(&dest)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["clone", "--progress", &url])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let name = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git");
    Ok(format!("{}/{}", dest.trim_end_matches('/'), name))
}

#[tauri::command]
fn git_stage(cwd: String, path: String) -> Result<(), String> {
    run_git(&cwd, &["add", "--", &path]).map(|_| ())
}

#[tauri::command]
fn git_stage_all(cwd: String) -> Result<(), String> {
    run_git(&cwd, &["add", "-A"]).map(|_| ())
}

#[tauri::command]
fn git_unstage(cwd: String, path: String) -> Result<(), String> {
    run_git(&cwd, &["reset", "-q", "HEAD", "--", &path]).map(|_| ())
}

#[tauri::command]
fn git_commit(cwd: String, message: String) -> Result<String, String> {
    run_git(&cwd, &["commit", "-m", &message])
}

#[tauri::command]
fn git_push(cwd: String) -> Result<String, String> {
    run_git(&cwd, &["push"])
}

/// Push and set upstream to origin for the current branch — used the first
/// time a branch is published.
#[tauri::command]
fn git_publish(cwd: String) -> Result<String, String> {
    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    run_git(&cwd, &["push", "-u", "origin", &branch])
}

#[tauri::command]
fn git_pull(cwd: String) -> Result<String, String> {
    run_git(&cwd, &["pull"])
}

#[tauri::command]
fn git_get_remote(cwd: String, name: String) -> Result<String, String> {
    run_git(&cwd, &["remote", "get-url", &name]).map(|s| s.trim().to_string())
}

/// Point a remote at a URL (GitHub / GitLab / custom). Updates the URL if the
/// remote already exists, otherwise adds it.
#[tauri::command]
fn git_set_remote(cwd: String, name: String, url: String) -> Result<(), String> {
    if run_git(&cwd, &["remote", "set-url", &name, &url]).is_err() {
        run_git(&cwd, &["remote", "add", &name, &url])?;
    }
    Ok(())
}

// ===========================================================================
// Integrated terminal — a PTY-backed shell streamed to the frontend.
// ===========================================================================

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct TermState(Mutex<HashMap<String, PtySession>>);

#[tauri::command]
fn term_open(
    app: tauri::AppHandle,
    state: tauri::State<TermState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Dropping the slave lets the shell see EOF when it exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app2 = app.clone();
    let data_event = format!("term-data:{}", id);
    let exit_event = format!("term-exit:{}", id);
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app2.emit(&data_event, chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit(&exit_event, ());
    });

    state.0.lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
fn term_write(state: tauri::State<TermState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
fn term_resize(
    state: tauri::State<TermState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    if let Some(s) = map.get(&id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn term_close(state: tauri::State<TermState>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

// ===========================================================================
// ESP32 — list serial ports and flash firmware over USB via the `espflash`
// CLI. Output is streamed to the frontend as `esp-log` / `esp-done` events.
// ===========================================================================

#[tauri::command]
fn serial_ports() -> Result<Vec<String>, String> {
    let mut ports = Vec::new();
    if let Ok(entries) = fs::read_dir("/dev") {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("ttyUSB")
                || name.starts_with("ttyACM")
                || name.starts_with("cu.")
                || name.starts_with("tty.usb")
            {
                ports.push(format!("/dev/{}", name));
            }
        }
    }
    ports.sort();
    Ok(ports)
}

#[tauri::command]
fn esp_flash(
    app: tauri::AppHandle,
    port: String,
    chip: Option<String>,
    image: String,
    baud: Option<u32>,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "flash".into(),
        "--port".into(),
        port,
        "--non-interactive".into(),
    ];
    if let Some(c) = chip {
        if !c.is_empty() {
            args.push("--chip".into());
            args.push(c);
        }
    }
    if let Some(b) = baud {
        args.push("--baud".into());
        args.push(b.to_string());
    }
    args.push(image);

    thread::spawn(move || {
        let spawned = win_cmd("espflash")
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "esp-log",
                    format!("Failed to launch espflash: {e}. Is it installed and on PATH?"),
                );
                let _ = app.emit("esp-done", false);
                return;
            }
        };

        // Drain stderr on its own thread so a full pipe can't deadlock stdout.
        if let Some(err) = child.stderr.take() {
            let app_err = app.clone();
            thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let _ = app_err.emit("esp-log", line);
                }
            });
        }
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app.emit("esp-log", line);
            }
        }

        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let _ = app.emit("esp-done", ok);
    });

    Ok(())
}

// ===========================================================================
// Search — recursive content search across the open folder.
// ===========================================================================

#[derive(Serialize)]
struct SearchHit {
    path: String,
    line: u32,
    text: String,
}

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "vendor",
    ".cache",
];

#[tauri::command]
fn search_files(
    root: String,
    query: String,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let cap = if max_results == 0 { 1000 } else { max_results };
    let needle = if case_sensitive {
        query.clone()
    } else {
        query.to_lowercase()
    };

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut stack = vec![PathBuf::from(&root)];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if hits.len() >= cap {
                return Ok(hits);
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > 2_000_000 {
                        continue;
                    }
                }
                let content = match fs::read_to_string(entry.path()) {
                    Ok(c) => c,
                    Err(_) => continue, // binary / non-UTF-8
                };
                for (i, line) in content.lines().enumerate() {
                    let hay = if case_sensitive {
                        line.to_string()
                    } else {
                        line.to_lowercase()
                    };
                    if hay.contains(&needle) {
                        hits.push(SearchHit {
                            path: to_string(&entry.path()),
                            line: (i + 1) as u32,
                            text: line.chars().take(240).collect(),
                        });
                        if hits.len() >= cap {
                            return Ok(hits);
                        }
                    }
                }
            }
        }
    }
    Ok(hits)
}

// ===========================================================================
// Live Server — static HTTP server for the open folder with poll-based live
// reload (no extra browser tooling needed).
// ===========================================================================

struct LiveServer {
    stop: Arc<AtomicBool>,
    port: u16,
}

#[derive(Default)]
struct LiveState(Mutex<Option<LiveServer>>);

const LIVE_RELOAD_JS: &str = r#"<script>(function(){let last=null;async function poll(){try{const r=await fetch('/__livereload');const t=await r.text();if(last!==null&&t!==last){location.reload();}last=t;}catch(e){}setTimeout(poll,1000);}poll();})();</script>"#;

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn max_mtime(root: &Path) -> u64 {
    let mut max = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if let Ok(ft) = e.file_type() {
                    if ft.is_dir() {
                        stack.push(e.path());
                    } else if let Ok(meta) = e.metadata() {
                        if let Ok(modt) = meta.modified() {
                            if let Ok(dur) = modt.duration_since(std::time::UNIX_EPOCH) {
                                let ms = dur.as_millis() as u64;
                                if ms > max {
                                    max = ms;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    max
}

fn ct_header(ct: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap()
}

fn respond_404(req: tiny_http::Request) {
    let _ = req.respond(tiny_http::Response::from_string("404 Not Found").with_status_code(404));
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Split a CGI response into (headers, body) at the first blank line.
fn split_cgi(raw: &[u8]) -> (&[u8], &[u8]) {
    if let Some(p) = find_sub(raw, b"\r\n\r\n") {
        (&raw[..p], &raw[p + 4..])
    } else if let Some(p) = find_sub(raw, b"\n\n") {
        (&raw[..p], &raw[p + 2..])
    } else {
        (&[], raw)
    }
}

fn parse_cgi(raw: Vec<u8>) -> (u16, String, Vec<u8>) {
    let (head, body) = split_cgi(&raw);
    let head_str = String::from_utf8_lossy(head);
    let mut status = 200u16;
    let mut ct = "text/html; charset=utf-8".to_string();
    for line in head_str.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("status:") {
            let digits: String = rest.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(c) = digits.parse() {
                status = c;
            }
        } else if lower.starts_with("content-type:") {
            if let Some(idx) = line.find(':') {
                ct = line[idx + 1..].trim().to_string();
            }
        }
    }
    (status, ct, body.to_vec())
}

/// Run a .php file and return (status, content_type, body). Prefers php-cgi
/// (full CGI with $_GET/$_POST); falls back to the `php` CLI (body only).
fn run_php(file: &Path, method: &str, query: &str, body: &[u8]) -> Option<(u16, String, Vec<u8>)> {
    let script = file.to_string_lossy().to_string();
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut cmd = win_cmd("php-cgi");
    cmd.env("REDIRECT_STATUS", "200")
        .env("GATEWAY_INTERFACE", "CGI/1.1")
        .env("SERVER_PROTOCOL", "HTTP/1.1")
        .env("SERVER_SOFTWARE", "editor-ide-live")
        .env("REQUEST_METHOD", method)
        .env("SCRIPT_FILENAME", &script)
        .env("SCRIPT_NAME", format!("/{name}"))
        .env("QUERY_STRING", query)
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("CONTENT_TYPE", "application/x-www-form-urlencoded")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    if let Ok(mut child) = cmd.spawn() {
        if let Some(mut sin) = child.stdin.take() {
            let _ = sin.write_all(body);
        }
        if let Ok(out) = child.wait_with_output() {
            return Some(parse_cgi(out.stdout));
        }
    }

    // Fallback: plain `php` CLI — no request context, body only.
    let out = win_cmd("php").arg(&script).output().ok()?;
    if !out.status.success() && out.stdout.is_empty() {
        let mut msg = b"PHP error:\n".to_vec();
        msg.extend_from_slice(&out.stderr);
        return Some((500, "text/plain; charset=utf-8".to_string(), msg));
    }
    Some((200, "text/html; charset=utf-8".to_string(), out.stdout))
}

fn handle_live_request(mut req: tiny_http::Request, root: &Path, php: bool) {
    let raw_url = req.url().to_string();
    let (path_part, query) = match raw_url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (raw_url, String::new()),
    };

    if path_part == "/__livereload" {
        let _ = req.respond(tiny_http::Response::from_string(max_mtime(root).to_string()));
        return;
    }

    let method = req.method().as_str().to_uppercase();
    let rel = path_part.trim_start_matches('/');
    let mut path = root.join(rel);
    if path_part.ends_with('/') || path_part == "/" || path.is_dir() {
        let php_index = path.join("index.php");
        if php && php_index.exists() {
            path = php_index;
        } else {
            path = path.join("index.html");
        }
    }

    let canon_root = match root.canonicalize() {
        Ok(c) => c,
        Err(_) => return respond_404(req),
    };
    let cp = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => return respond_404(req),
    };
    if !cp.starts_with(&canon_root) {
        return respond_404(req);
    }

    let is_php = cp
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("php"))
        .unwrap_or(false);

    if php && is_php {
        let mut body = Vec::new();
        if method == "POST" || method == "PUT" {
            let _ = req.as_reader().read_to_end(&mut body);
        }
        match run_php(&cp, &method, &query, &body) {
            Some((status, ct, mut out)) => {
                if ct.starts_with("text/html") {
                    out.extend_from_slice(LIVE_RELOAD_JS.as_bytes());
                }
                let _ = req.respond(
                    tiny_http::Response::from_data(out)
                        .with_status_code(status)
                        .with_header(ct_header(&ct)),
                );
            }
            None => {
                let _ = req.respond(
                    tiny_http::Response::from_string(
                        "PHP is not installed (need php-cgi or php on PATH).",
                    )
                    .with_status_code(500),
                );
            }
        }
        return;
    }

    match fs::read(&cp) {
        Ok(bytes) => {
            let ct = content_type(&cp);
            if ct.starts_with("text/html") {
                let mut html = String::from_utf8_lossy(&bytes).into_owned();
                html.push_str(LIVE_RELOAD_JS);
                let _ = req.respond(tiny_http::Response::from_string(html).with_header(ct_header(ct)));
            } else {
                let _ = req.respond(tiny_http::Response::from_data(bytes).with_header(ct_header(ct)));
            }
        }
        Err(_) => respond_404(req),
    }
}

/// Does `root` contain at least one `.php` file? A bounded walk that skips
/// heavy/vendor directories and gives up after a fixed budget, so PHP is only
/// ever spun up for projects that actually use it (and a huge tree can't stall
/// server startup).
fn project_has_php(root: &Path) -> bool {
    const SKIP: &[&str] = &[
        "node_modules", ".git", "vendor", "dist", "build", "target", ".next", ".cache",
    ];
    let mut stack = vec![root.to_path_buf()];
    let mut budget = 5000usize;
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if budget == 0 {
                return false;
            }
            budget -= 1;
            let ft = match entry.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with('.') || SKIP.contains(&name.as_ref()) {
                    continue;
                }
                stack.push(entry.path());
            } else if entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("php"))
                .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
fn live_server_start(
    state: tauri::State<LiveState>,
    root: String,
    php: bool,
) -> Result<u16, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(ls) = guard.as_ref() {
        return Ok(ls.port);
    }
    // Only run in PHP mode if the project actually contains a .php file.
    let php = php && project_has_php(Path::new(&root));
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "could not determine server port".to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let root_pb = PathBuf::from(&root);
    thread::spawn(move || loop {
        if stop_thread.load(Ordering::Relaxed) {
            break;
        }
        match server.recv_timeout(Duration::from_millis(300)) {
            Ok(Some(req)) => handle_live_request(req, &root_pb, php),
            Ok(None) => {}
            Err(_) => break,
        }
    });

    *guard = Some(LiveServer { stop, port });
    Ok(port)
}

#[tauri::command]
fn live_server_stop(state: tauri::State<LiveState>) -> Result<(), String> {
    if let Some(ls) = state.0.lock().unwrap().take() {
        ls.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn live_server_status(state: tauri::State<LiveState>) -> Option<u16> {
    state.0.lock().unwrap().as_ref().map(|l| l.port)
}

// ===========================================================================
// HTTP fetch (backend, no CORS) — used to pull themes from the Open VSX
// registry: JSON metadata as text, and the .vsix archive as base64.
// ===========================================================================

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn http_get_text(url: String) -> Result<String, String> {
    ureq::get(&url)
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Open a URL in the system default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let prog = "xdg-open";
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    win_cmd(prog)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn http_get_base64(url: String) -> Result<String, String> {
    let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(base64_encode(&buf))
}

// ===========================================================================
// GitHub — reuse the user's GitHub CLI (`gh`) auth to list repositories for
// the clone picker. No separate sign-in/token: we shell out to `gh`, which the
// user already logged in with via `gh auth login`.
// ===========================================================================

#[derive(Serialize)]
struct GhRepo {
    full_name: String,
    clone_url: String,
    private: bool,
    description: String,
}

/// The token `gh` is logged in with — reused so private clones work over git
/// without a separate sign-in.
#[tauri::command]
fn gh_cli_token() -> Result<String, String> {
    let out = win_cmd("gh")
        .args(["auth", "token"])
        .output()
        .map_err(|_| "GitHub CLI (gh) is not installed.".to_string())?;
    let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || tok.is_empty() {
        return Err("Not logged in to the GitHub CLI. Run: gh auth login".to_string());
    }
    Ok(tok)
}

/// List every repo the `gh`-authenticated account owns or can access.
#[tauri::command]
fn gh_cli_repos() -> Result<Vec<GhRepo>, String> {
    let out = win_cmd("gh")
        .args([
            "api",
            "-H",
            "Accept: application/vnd.github+json",
            "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
            "--paginate",
        ])
        .output()
        .map_err(|_| "GitHub CLI (gh) is not installed.".to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("auth") || err.contains("logged in") || err.contains("authentication") {
            return Err("Not logged in to the GitHub CLI. Run: gh auth login".to_string());
        }
        return Err(err.trim().to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let mut repos = Vec::new();
    if let Some(arr) = v.as_array() {
        for r in arr {
            repos.push(GhRepo {
                full_name: r["full_name"].as_str().unwrap_or_default().to_string(),
                clone_url: r["clone_url"].as_str().unwrap_or_default().to_string(),
                private: r["private"].as_bool().unwrap_or(false),
                description: r["description"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    Ok(repos)
}

/// Clone a GitHub repo, injecting the token for private repos, then scrubbing
/// it from the stored remote so it never lands in .git/config.
#[tauri::command]
fn gh_clone(clone_url: String, token: String, dest: String) -> Result<String, String> {
    let auth_url = if token.is_empty() {
        clone_url.clone()
    } else {
        clone_url.replacen("https://", &format!("https://x-access-token:{}@", token), 1)
    };
    let out = win_cmd("git")
        .current_dir(&dest)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["clone", "--progress", &auth_url])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let name = clone_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git");
    let path = format!("{}/{}", dest.trim_end_matches('/'), name);
    if !token.is_empty() {
        let _ = win_cmd("git")
            .current_dir(&path)
            .args(["remote", "set-url", "origin", &clone_url])
            .output();
    }
    Ok(path)
}

// ===========================================================================
// SSH / SFTP — open and edit a remote folder over SSH.
// ===========================================================================

use ssh2::Session;
use std::net::TcpStream;

#[derive(Default)]
struct SshState(Mutex<HashMap<String, Session>>);

fn sftp_for<'a>(
    map: &'a std::collections::HashMap<String, Session>,
    id: &str,
) -> Result<ssh2::Sftp, String> {
    let sess = map.get(id).ok_or("not connected")?;
    sess.sftp().map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_connect(
    state: tauri::State<SshState>,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<String, String> {
    let tcp = TcpStream::connect((host.as_str(), port)).map_err(|e| e.to_string())?;
    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;

    if let Some(k) = key_path.filter(|k| !k.is_empty()) {
        sess.userauth_pubkey_file(&user, None, Path::new(&k), None)
            .map_err(|e| e.to_string())?;
    } else if let Some(p) = password.filter(|p| !p.is_empty()) {
        sess.userauth_password(&user, &p).map_err(|e| e.to_string())?;
    } else {
        sess.userauth_agent(&user).map_err(|e| e.to_string())?;
    }
    if !sess.authenticated() {
        return Err("authentication failed".into());
    }

    let id = format!("{user}@{host}:{port}");
    state.0.lock().unwrap().insert(id.clone(), sess);
    Ok(id)
}

#[tauri::command]
fn ssh_disconnect(state: tauri::State<SshState>, id: String) {
    state.0.lock().unwrap().remove(&id);
}

#[tauri::command]
fn ssh_home(state: tauri::State<SshState>, id: String) -> Result<String, String> {
    let map = state.0.lock().unwrap();
    let sess = map.get(&id).ok_or("not connected")?;
    let mut ch = sess.channel_session().map_err(|e| e.to_string())?;
    ch.exec("pwd").map_err(|e| e.to_string())?;
    let mut s = String::new();
    ch.read_to_string(&mut s).map_err(|e| e.to_string())?;
    let _ = ch.wait_close();
    let p = s.trim().to_string();
    Ok(if p.is_empty() { "/".into() } else { p })
}

#[tauri::command]
fn ssh_list_dir(state: tauri::State<SshState>, id: String, path: String) -> Result<Vec<Entry>, String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    let items = sftp.readdir(Path::new(&path)).map_err(|e| e.to_string())?;
    let mut entries: Vec<Entry> = items
        .into_iter()
        .filter_map(|(p, stat)| {
            let name = p.file_name()?.to_string_lossy().to_string();
            Some(Entry {
                name,
                path: to_string(&p),
                is_dir: stat.is_dir(),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn ssh_read_file(state: tauri::State<SshState>, id: String, path: String) -> Result<String, String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    let mut f = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    String::from_utf8(buf).map_err(|_| "binary or non-UTF-8 file".to_string())
}

#[tauri::command]
fn ssh_read_file_base64(state: tauri::State<SshState>, id: String, path: String) -> Result<String, String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    let mut f = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64_encode(&buf))
}

#[tauri::command]
fn ssh_write_file(
    state: tauri::State<SshState>,
    id: String,
    path: String,
    contents: String,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    let mut f = sftp.create(Path::new(&path)).map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_create_file(state: tauri::State<SshState>, id: String, path: String) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    if sftp.stat(Path::new(&path)).is_ok() {
        return Err("already exists".into());
    }
    sftp.create(Path::new(&path)).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_create_dir(state: tauri::State<SshState>, id: String, path: String) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    sftp.mkdir(Path::new(&path), 0o755).map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_rename(state: tauri::State<SshState>, id: String, from: String, to: String) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    sftp.rename(Path::new(&from), Path::new(&to), None).map_err(|e| e.to_string())
}

fn ssh_rm_recursive(sftp: &ssh2::Sftp, path: &Path) -> Result<(), String> {
    let stat = sftp.stat(path).map_err(|e| e.to_string())?;
    if stat.is_dir() {
        for (p, _) in sftp.readdir(path).map_err(|e| e.to_string())? {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name == "." || name == ".." {
                continue;
            }
            ssh_rm_recursive(sftp, &p)?;
        }
        sftp.rmdir(path).map_err(|e| e.to_string())
    } else {
        sftp.unlink(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn ssh_delete(state: tauri::State<SshState>, id: String, path: String) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let sftp = sftp_for(&map, &id)?;
    ssh_rm_recursive(&sftp, Path::new(&path))
}

// ===========================================================================
// Debugging — launch Node under the inspector (CDP) or run a program and
// stream its output to the Debug Console.
// ===========================================================================

#[derive(Default)]
struct DebugState(Mutex<Option<std::process::Child>>);

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Launch `node --inspect-brk` on `file` and return the inspector WebSocket URL.
#[tauri::command]
fn dbg_node_start(
    app: tauri::AppHandle,
    state: tauri::State<DebugState>,
    file: String,
    cwd: Option<String>,
) -> Result<String, String> {
    if let Some(mut c) = state.0.lock().unwrap().take() {
        let _ = c.kill();
    }
    let port = free_port()?;
    let mut cmd = win_cmd("node");
    cmd.arg(format!("--inspect-brk=127.0.0.1:{port}")).arg(&file);
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(d);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not launch node: {e}"))?;
    // stream the program's stdout/stderr to the Debug Console
    if let Some(out) = child.stdout.take() {
        let a = app.clone();
        thread::spawn(move || {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = a.emit("dbg-out", l + "\n");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let a = app.clone();
        thread::spawn(move || {
            for l in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = a.emit("dbg-out", l + "\n");
            }
        });
    }
    *state.0.lock().unwrap() = Some(child);

    let url = format!("http://127.0.0.1:{port}/json/list");
    let mut ws = String::new();
    for _ in 0..40 {
        if let Ok(resp) = ureq::get(&url).call() {
            let body = resp.into_string().unwrap_or_default();
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(&body) {
                if let Some(w) = arr.get(0).and_then(|x| x["webSocketDebuggerUrl"].as_str()) {
                    ws = w.to_string();
                    break;
                }
            }
        }
        thread::sleep(Duration::from_millis(120));
    }
    if ws.is_empty() {
        return Err("could not reach the Node inspector".into());
    }
    Ok(ws)
}

/// Run a program, streaming stdout/stderr to the frontend as `dbg-out` events
/// and a final `dbg-exit`. Used for PHP / plain runs.
#[tauri::command]
fn dbg_run(
    app: tauri::AppHandle,
    state: tauri::State<DebugState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    if let Some(mut c) = state.0.lock().unwrap().take() {
        let _ = c.kill();
    }
    let mut cmd = win_cmd(&program);
    cmd.args(&args);
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(d);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not launch {program}: {e}"))?;

    if let Some(err) = child.stderr.take() {
        let a = app.clone();
        thread::spawn(move || {
            for l in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = a.emit("dbg-out", l + "\n");
            }
        });
    }
    if let Some(out) = child.stdout.take() {
        let a = app.clone();
        thread::spawn(move || {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = a.emit("dbg-out", l + "\n");
            }
            let _ = a.emit("dbg-exit", ());
        });
    }
    *state.0.lock().unwrap() = Some(child);
    Ok(())
}

#[tauri::command]
fn dbg_stop(state: tauri::State<DebugState>) {
    if let Some(mut c) = state.0.lock().unwrap().take() {
        let _ = c.kill();
    }
}

static WINDOW_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);

/// Open a second app window.
#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    tauri::WebviewWindowBuilder::new(&app, format!("w{n}"), tauri::WebviewUrl::App("index.html".into()))
        .title("Bi-Code")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 400.0)
        .decorations(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TermState::default())
        .manage(LiveState::default())
        .manage(SshState::default())
        .manage(DebugState::default())
        .setup(|app| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_icon(tauri::include_image!("icons/icon.png"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            read_file_base64,
            write_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            base_name,
            sqlite_tables,
            sqlite_table,
            sqlite_query,
            sqlite_update_cell,
            sqlite_insert_row,
            sqlite_delete_row,
            git_status,
            git_init,
            git_clone,
            new_window,
            dbg_node_start,
            dbg_run,
            dbg_stop,
            git_stage,
            git_stage_all,
            git_unstage,
            git_commit,
            git_push,
            git_publish,
            git_pull,
            git_get_remote,
            git_set_remote,
            term_open,
            term_write,
            term_resize,
            term_close,
            serial_ports,
            esp_flash,
            search_files,
            live_server_start,
            live_server_stop,
            live_server_status,
            http_get_text,
            http_get_base64,
            open_url,
            gh_cli_token,
            gh_cli_repos,
            gh_clone,
            ssh_connect,
            ssh_disconnect,
            ssh_home,
            ssh_list_dir,
            ssh_read_file,
            ssh_read_file_base64,
            ssh_write_file,
            ssh_create_file,
            ssh_create_dir,
            ssh_rename,
            ssh_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
