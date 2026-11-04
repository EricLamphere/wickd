#!/usr/bin/env python3
"""Take wickd's README/website screenshots in the real desktop shell.

`up` builds the working tree's frontend with driver.js injected, seeds an
isolated data dir and demo project, and starts a backend on BACKEND_PORT with the
debug Tauri shell attached to it. Nothing touches your dev servers, dev database,
or real dbt project. Other commands talk to the running `up` over CONTROL_PORT.

See ../SKILL.md. Standard library only (runs on any python3).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from shot_manifest import (
    ManifestError,
    Shot,
    coverage_problems,
    is_hero,
    load_shots,
    readme_features,
    render_gallery,
    replace_gallery,
    set_hero_alt,
    site_assets,
    stale_assets,
    step_to_js,
)

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
REPO = SKILL.parents[2]
MANIFEST = SKILL / "shots.json"
WORK = REPO / "data" / "screenshots"
OUT = WORK / "out"
DEV_DATA = REPO / "data"
SITE = REPO.parent / "lamphere-labs"
SITE_ASSETS = SITE / "assets" / "img"
SITE_PAGE = SITE / "tools" / "wickd" / "index.html"
SITE_GALLERY_PAGE = SITE / "tools" / "wickd" / "gallery" / "index.html"
PRO_CHECKOUT = REPO.parent / "wickd-pro"
SHELL_BIN = REPO / "src-tauri" / "target" / "debug" / "wickd"

BACKEND_PORT = 8002
CONTROL_PORT = 8765
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"
CONTROL_URL = f"http://127.0.0.1:{CONTROL_PORT}"
# The app lays out as a 2400x1391 window: macOS caps a real window's height at the display's,
# so it's this size at 80% page zoom. Proportions match img/ (4064x2514 with the shadow).
WINDOW_SIZE = "1920x1145"
WINDOW_ZOOM = "0.8"

DEMO_ROOT = Path("/Users/Shared/wickd-demo")
SHARED_DATA = ("models", "dbt-charts-venv")
STALE_RESULT_TABLES = ("contract_check_snapshots", "data_diff_snapshots")
BACKEND_READY_TIMEOUT = 60
COMMAND_TIMEOUT = 120
DOWN_TIMEOUT = 30
EDIT_SETTLE_SECONDS = 4
FOCUS_SETTLE_SECONDS = 0.4


def fail(message: str) -> None:
    sys.exit(f"shotctl: {message}")


def read_manifest() -> dict:
    return json.loads(MANIFEST.read_text())


# ── Seeding ──────────────────────────────────────────────────────────────────


def build_frontend() -> Path:
    """vite only (no tsc: work in progress mustn't block a shot), into a throwaway dir."""
    dist = WORK / "frontend"
    subprocess.run(
        ["npx", "vite", "build", "--outDir", str(dist), "--emptyOutDir", "--logLevel", "warn"],
        cwd=REPO / "frontend",
        check=True,
    )
    driver = (SCRIPTS / "driver.js").read_text().replace("__CONTROLLER__", CONTROL_URL)
    (dist / "shot-driver.js").write_text(driver)
    index = dist / "index.html"
    index.write_text(index.read_text().replace("</head>", '<script src="/shot-driver.js"></script></head>'))
    return dist


def seed_demo_projects(demo: dict) -> None:
    """Fresh copies of the demo projects, then the edits shots rely on (uncommitted changes etc.)."""
    source_root = Path(demo["source_root"]).expanduser()
    DEMO_ROOT.mkdir(parents=True, exist_ok=True)
    for name in demo["projects"]:
        subprocess.run(
            [
                "rsync",
                "-a",
                "--delete",
                "--delete-excluded",
                "--exclude",
                "logs/",
                "--exclude",
                ".git/worktrees/",  # the source's metric-compare checkouts belong to the dev data dir
                f"{source_root / name}/",
                f"{DEMO_ROOT / name}/",
            ],
            check=True,
        )
    (DEMO_ROOT / ".edits-applied").unlink(missing_ok=True)
    for edit in demo.get("seed_edits", ()):
        apply_edit(edit)
    (DEMO_ROOT / ".zdotdir").mkdir(exist_ok=True)
    (DEMO_ROOT / ".zdotdir" / ".zshrc").write_text("PROMPT='%F{cyan}%1~%f %# '\nunsetopt PROMPT_SP\n")


def commit_demo_state(demo: dict) -> None:
    """A clean working tree in the copies, so Source Control shows only the demo edits."""
    identity = ("-c", "user.name=wickd demo", "-c", "user.email=demo@example.com")
    for name in demo["projects"]:
        project = DEMO_ROOT / name
        if not (project / ".git").exists():
            continue
        subprocess.run(["git", "add", "-A"], cwd=project, check=True)
        subprocess.run(
            ["git", *identity, "commit", "-qm", "demo state", "--no-verify"],
            cwd=project,
            check=False,
            capture_output=True,
        )


def set_demo_edits(demo: dict, group: str | None) -> None:
    """Uncommitted changes exist only for the shots that name an `edits` group, and only that group."""
    marker = DEMO_ROOT / ".edits-applied"
    current = marker.read_text() if marker.exists() else None
    if group == current:
        return
    groups = demo.get("edits", {})
    if group is not None and group not in groups:
        fail(f"unknown edits group: {group}")
    for edit in groups.get(current, ()):
        path = DEMO_ROOT / edit["file"]
        subprocess.run(["git", "checkout", "--", path.name], cwd=path.parent, check=True)
    for edit in groups.get(group, ()):
        apply_edit(edit)
    if group is None:
        marker.unlink(missing_ok=True)
    else:
        marker.write_text(group)
    time.sleep(EDIT_SETTLE_SECONDS)  # the watcher's debounce, then the silent `dbt parse`


def apply_edit(edit: dict) -> None:
    path = DEMO_ROOT / edit["file"]
    if "content" in edit:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(edit["content"])
        return
    if edit.get("delete"):
        path.unlink()
        return
    text = path.read_text()
    if "prepend" in edit:
        path.write_text(edit["prepend"] + text)
        return
    if edit["find"] not in text:
        fail(f"demo edit no longer applies, update shots.json: {edit['file']}: {edit['find']!r}")
    path.write_text(text.replace(edit["find"], edit["replace"], edit.get("count", -1)))


def seed_database(data_dir: Path, tier: str, demo: dict) -> None:
    """A copy of the dev DB (run history etc.) pointed at the demo projects."""
    source = sqlite3.connect(f"file:{DEV_DATA / 'wickd.sqlite'}?mode=ro", uri=True)
    target = sqlite3.connect(data_dir / "wickd.sqlite")
    try:
        source.backup(target)
        for project_id, name in target.execute("SELECT id, name FROM projects").fetchall():
            if name in demo["projects"]:
                target.execute("UPDATE projects SET path=?, ignored=0 WHERE id=?", (str(DEMO_ROOT / name), project_id))
            else:
                target.execute("DELETE FROM projects WHERE id=?", (project_id,))
        target.execute("UPDATE app_settings SET value=? WHERE key='dbt_projects_path'", (str(DEMO_ROOT),))
        target.execute("DELETE FROM app_settings WHERE key='global_requirements_path'")
        # A shot may only show a check it ran: results here describe the dev project's old state.
        for table in STALE_RESULT_TABLES:
            target.execute(f"DELETE FROM {table}")
        if tier == "base":
            target.execute("DELETE FROM license_state")
        target.commit()
    finally:
        target.close()
        source.close()


def seed_data_dir(tier: str, demo: dict) -> Path:
    data_dir = WORK / tier
    shutil.rmtree(data_dir, ignore_errors=True)
    data_dir.mkdir(parents=True)
    seed_database(data_dir, tier, demo)
    for name in SHARED_DATA:
        if (DEV_DATA / name).exists():
            (data_dir / name).symlink_to(DEV_DATA / name)
    return data_dir


# ── Processes ────────────────────────────────────────────────────────────────


def port_free(port: int) -> bool:
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", port)) != 0


def demo_link(name: str) -> Path:
    """The dev venv under a path that's safe to show on screen."""
    link = DEMO_ROOT / f".{name}"
    link.unlink(missing_ok=True)
    link.symlink_to(DEV_DATA / name)
    return link


def start_backend(tier: str, data_dir: Path, dist: Path) -> subprocess.Popen:
    env = {
        **os.environ,
        "WICKD_DATA_DIR": str(data_dir),
        "WICKD_FRONTEND_DIST": str(dist),
        "WICKD_PROJECTS_PATH": str(DEMO_ROOT),
        "WICKD_DBT_VENV_DIR": str(demo_link("dbt-venv")),
        "WICKD_METRICFLOW_VENV_DIR": str(demo_link("metricflow-venv")),
        # Whatever the app shows from these (Downloads, the terminal, venv paths) stays demo-only.
        "HOME": str(DEMO_ROOT),
        "ZDOTDIR": str(DEMO_ROOT / ".zdotdir"),
        "SHELL": "/bin/zsh",
    }
    if tier == "pro":
        env["PYTHONPATH"] = str(PRO_CHECKOUT)
    log = (data_dir / "backend.log").open("w")
    return subprocess.Popen(
        [".venv/bin/uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(BACKEND_PORT)],
        cwd=REPO / "backend",
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )


def wait_for_backend(process: subprocess.Popen) -> None:
    deadline = time.monotonic() + BACKEND_READY_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            fail(f"backend exited with {process.returncode}; see {WORK}/<tier>/backend.log")
        try:
            with urllib.request.urlopen(f"{BACKEND_URL}/api/health", timeout=2):
                return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.3)
    fail("backend never became healthy")


def start_shell() -> subprocess.Popen:
    subprocess.run(["cargo", "build", "--quiet"], cwd=REPO / "src-tauri", check=True)
    env = {**os.environ, "WICKD_SHELL_URL": BACKEND_URL, "WICKD_SHELL_SIZE": WINDOW_SIZE, "WICKD_SHELL_ZOOM": WINDOW_ZOOM}
    return subprocess.Popen([str(SHELL_BIN)], env=env)


def window_id(pid: int) -> str:
    result = subprocess.run(
        ["swift", str(SCRIPTS / "windows.swift"), str(pid)], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(f"can't find the shell's window: {result.stderr.strip()}")
    return result.stdout.strip()


# ── Controller (up) ──────────────────────────────────────────────────────────


class Bridge:
    """Hands JS to whichever page is long-polling, and waits for its reply."""

    def __init__(self) -> None:
        self.commands: queue.Queue[dict] = queue.Queue()
        self.waiting: dict[int, queue.Queue] = {}
        self.next_id = 0
        self.lock = threading.Lock()
        self.last_poll = 0.0
        self.retired: set[str] = set()

    def next_command(self, page: str, wait: float = 2.0) -> dict | None:
        """A command for `page`, unless it's navigating away: its poll would swallow the command."""
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if page in self.retired:
                return None
            self.last_poll = time.monotonic()
            try:
                return self.commands.get(timeout=0.1)
            except queue.Empty:
                continue
        return None

    def retire(self, page: str | None) -> None:
        if page:
            self.retired.add(page)
            self.last_poll = 0.0

    def run(self, js: str, timeout: float) -> dict:
        with self.lock:
            self.next_id += 1
            command_id = self.next_id
            reply: queue.Queue = queue.Queue(maxsize=1)
            self.waiting[command_id] = reply
        self.commands.put({"id": command_id, "js": js})
        try:
            return reply.get(timeout=timeout)
        except queue.Empty:
            return {"ok": False, "error": f"no reply within {timeout}s (page reloaded mid-command?)"}
        finally:
            with self.lock:
                self.waiting.pop(command_id, None)

    def resolve(self, result: dict) -> None:
        with self.lock:
            reply = self.waiting.get(result.get("id"))
        if reply is not None:
            reply.put(result)


def run_applescript(script: str) -> str:
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"focus: {result.stderr.strip()}", flush=True)
    return result.stdout.strip()


def set_frontmost(pid: str | int) -> None:
    run_applescript(
        f'tell application "System Events" to set frontmost of first process whose unix id is {pid} to true'
    )


@contextmanager
def focused(pid: int) -> Iterator[None]:
    previous = run_applescript(
        'tell application "System Events" to get unix id of first process whose frontmost is true'
    )
    set_frontmost(pid)
    time.sleep(FOCUS_SETTLE_SECONDS)
    try:
        yield
    finally:
        if previous:
            set_frontmost(previous)


class Session:
    def __init__(self, tier: str, shell_pid: int, stop: threading.Event) -> None:
        self.tier = tier
        self.shell_pid = shell_pid
        self.stop = stop
        self.bridge = Bridge()

    def capture(self, path: str) -> dict:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            window = window_id(self.shell_pid)
        except RuntimeError as error:
            return {"ok": False, "error": str(error)}
        # Colored traffic lights need the window focused: a moment of focus, then give it back.
        with focused(self.shell_pid):
            # -l window, -x silent. The default keeps the macOS shadow, as the existing shots have.
            result = subprocess.run(
                ["screencapture", "-x", "-l", window, str(target)],
                capture_output=True,
                text=True,
                check=False,
            )
        if result.returncode != 0 or not target.exists():
            return {"ok": False, "error": result.stderr.strip() or "screencapture wrote nothing (Screen Recording?)"}
        return {"ok": True, "value": str(target)}


def make_handler(session: Session) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def _reply(self, status: int, body: dict | None = None) -> None:
            data = json.dumps(body).encode() if body is not None else b""
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()

        def do_GET(self) -> None:
            if self.path.startswith("/next"):
                page = parse_qs(urlparse(self.path).query).get("page", [""])[0]
                command = session.bridge.next_command(page)
                if command is None:
                    self._reply(204)
                else:
                    self._reply(200, command)
            elif self.path == "/status":
                self._reply(200, {"tier": session.tier, "page_seen": time.monotonic() - session.bridge.last_poll < 5})
            else:
                self._reply(404)

        def do_POST(self) -> None:
            if self.path == "/result":
                session.bridge.resolve(self._body())
                self._reply(200, {})
            elif self.path == "/run":
                body = self._body()
                result = session.bridge.run(body["js"], body.get("timeout", COMMAND_TIMEOUT))
                if body.get("navigates"):
                    session.bridge.retire(result.get("page"))
                self._reply(200, result)
            elif self.path == "/capture":
                self._reply(200, session.capture(self._body()["path"]))
            elif self.path == "/down":
                self._reply(200, {"ok": True})
                session.stop.set()
            else:
                self._reply(404)

    return Handler


def stop_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def cmd_up(args: argparse.Namespace) -> None:
    for port in (BACKEND_PORT, CONTROL_PORT):
        if not port_free(port):
            fail(f"port {port} is in use (another `shotctl up`? try `shotctl down`)")
    if args.tier == "pro" and not PRO_CHECKOUT.is_dir():
        fail(f"Pro shots need the wickd-pro checkout at {PRO_CHECKOUT}")

    demo = read_manifest()["demo"]
    WORK.mkdir(parents=True, exist_ok=True)
    dist = build_frontend()
    seed_demo_projects(demo)
    data_dir = seed_data_dir(args.tier, demo)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    backend = shell = None
    try:
        backend = start_backend(args.tier, data_dir, dist)
        wait_for_backend(backend)
        shell = start_shell()
        session = Session(args.tier, shell.pid, stop)
        server = ThreadingHTTPServer(("127.0.0.1", CONTROL_PORT), make_handler(session))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"up: tier={args.tier} backend={BACKEND_URL} shell_pid={shell.pid}", flush=True)
        while not stop.is_set():
            if shell.poll() is not None:
                print("the shell window was closed", flush=True)
                break
            stop.wait(0.5)
        server.shutdown()
        server.server_close()
    finally:
        stop_process(shell)
        stop_process(backend)
    print("down", flush=True)


# ── Client commands ──────────────────────────────────────────────────────────


def control(path: str, body: dict | None = None, timeout: float = COMMAND_TIMEOUT + 10) -> dict:
    request = urllib.request.Request(
        f"{CONTROL_URL}{path}",
        data=json.dumps(body or {}).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.URLError as error:
        fail(f"no running session ({error.reason}); start one with `shotctl up --tier pro`")


class StepFailed(RuntimeError):
    pass


def run_js(js: str, timeout: float = COMMAND_TIMEOUT) -> object:
    try:
        reply = control("/run", {"js": js, "timeout": timeout}, timeout=timeout + 10)
    except TimeoutError as error:
        raise StepFailed(f"no reply within {timeout}s") from error
    if not reply.get("ok"):
        raise StepFailed(reply.get("error", "unknown error"))
    return reply.get("value")


def wait_for_page(timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if control("/status", timeout=5).get("page_seen"):
            return
        time.sleep(0.2)
    raise StepFailed("the page never connected to the controller")


def goto(path: str) -> None:
    """A full page load, so each shot starts from clean React state."""
    control(
        "/run",
        {
            "js": f"setTimeout(() => location.assign({json.dumps(path)}), 150); return true;",
            "timeout": 10,
            "navigates": True,
        },
    )
    wait_for_page()
    run_js("return await new Promise(r => { const c = () => document.readyState === 'complete' ? r(true) : setTimeout(c, 50); c(); });")


def project_ids() -> dict[str, int]:
    projects = run_js("return await shot.api('GET', '/api/projects');")
    return {project["name"]: project["id"] for project in projects}


def expand(step: dict, ids: dict[str, int]) -> dict:
    """{pid:name} in a step becomes that demo project's id."""
    text = json.dumps(step)
    for name, project_id in ids.items():
        text = text.replace(f"{{pid:{name}}}", str(project_id))
    return json.loads(text)


def reset_page(shot: Shot) -> None:
    run_js(
        f"await shot.api('PUT', '/api/settings', {{theme: {json.dumps(shot.theme)}}});"
        f"localStorage.clear(); sessionStorage.clear();"
        f"localStorage.setItem('wickd-theme', {json.dumps(shot.theme)});"
        f"Object.entries({json.dumps(shot.storage)}).forEach(([k, v]) => localStorage.setItem(k, v));"
        f"return true;"
    )


def run_shot(shot: Shot) -> Path:
    set_demo_edits(read_manifest()["demo"], shot.edits)
    wait_for_page()
    ids = project_ids()
    reset_page(shot)
    for raw_step in shot.steps:
        step = expand(raw_step, ids)
        try:
            if "goto" in step:
                goto(step["goto"])
            else:
                run_js(step_to_js(step), timeout=step.get("timeout", 20000) / 1000 + 30)
        except StepFailed as error:
            debug = OUT / f"{shot.name}.FAILED.png"
            control("/capture", {"path": str(debug)})
            raise StepFailed(f"{shot.name}: step {raw_step}: {error}\n  on-screen state: {debug}") from error
    run_js("return await shot.settle();")
    path = OUT / f"{shot.name}.png"
    reply = control("/capture", {"path": str(path)})
    if not reply.get("ok"):
        raise StepFailed(f"{shot.name}: capture failed: {reply.get('error')}")
    return path


def selected_shots(names: list[str], everything: bool) -> tuple[Shot, ...]:
    shots = load_shots(read_manifest())
    tier = control("/status", timeout=5)["tier"]
    if everything:
        return tuple(shot for shot in shots if shot.tier == tier)
    by_name = {shot.name: shot for shot in shots}
    unknown = [name for name in names if name not in by_name]
    if unknown:
        fail(f"unknown shots: {unknown}")
    wrong_tier = [name for name in names if by_name[name].tier != tier]
    if wrong_tier:
        fail(f"{wrong_tier} need another tier; this session is {tier}")
    return tuple(by_name[name] for name in names)


def cmd_run(args: argparse.Namespace) -> None:
    failures = []
    for shot in selected_shots(args.names, args.all):
        try:
            print(f"ok    {run_shot(shot)}", flush=True)
        except StepFailed as error:
            failures.append(shot.name)
            print(f"FAIL  {error}", flush=True)
    if failures:
        fail(f"failed: {failures}")


def cmd_prepare(_: argparse.Namespace) -> None:
    """Fresh runs and checks, then the demo edits (after the build, so it can't break it)."""
    demo = read_manifest()["demo"]
    wait_for_page()
    ids = project_ids()
    tier = control("/status", timeout=5)["tier"]
    steps = [step for step in demo["prepare"] if step.get("only_tier", tier) == tier]
    try:
        for raw_step in steps:
            step = expand({key: val for key, val in raw_step.items() if key != "only_tier"}, ids)
            print(f"prepare: {str(raw_step)[:70]}", flush=True)
            if "goto" in step:
                goto(step["goto"])
            else:
                run_js(step_to_js(step), timeout=step.get("timeout", COMMAND_TIMEOUT))
    except StepFailed as error:
        fail(f"prepare failed: {error}")
    commit_demo_state(demo)
    print("prepared", flush=True)


def cmd_js(args: argparse.Namespace) -> None:
    try:
        print(json.dumps(run_js(args.code), indent=1))
    except StepFailed as error:
        fail(str(error))


def cmd_goto(args: argparse.Namespace) -> None:
    goto(args.path)
    print(json.dumps(run_js("await shot.settle(); return shot.outline();"), indent=1))


def cmd_capture(args: argparse.Namespace) -> None:
    reply = control("/capture", {"path": str(OUT / f"{args.name}.png")})
    print(reply.get("value") or fail(reply.get("error", "capture failed")))


def cmd_down(_: argparse.Namespace) -> None:
    control("/down", {}, timeout=5)
    deadline = time.monotonic() + DOWN_TIMEOUT
    while time.monotonic() < deadline:
        if port_free(BACKEND_PORT) and port_free(CONTROL_PORT):
            return
        time.sleep(0.2)
    fail(f"the session is still holding port {BACKEND_PORT} or {CONTROL_PORT}")


def cmd_check(_: argparse.Namespace) -> None:
    manifest = read_manifest()
    try:
        shots = load_shots(manifest)
        features = readme_features((REPO / "README.md").read_text())
    except ManifestError as error:
        fail(str(error))
    upcoming = tuple(manifest.get("upcoming", ()))
    problems = coverage_problems(shots, features + upcoming, manifest.get("not_shown", {}))
    for problem in problems:
        print(f"- {problem}")
    if problems:
        fail(f"{len(problems)} problem(s)")
    print(f"{len(features)} README features, {len(shots)} shots: every feature is in exactly one shot or pair.")


def resize(source: Path, width: int, target: Path) -> None:
    subprocess.run(
        ["sips", "--resampleWidth", str(width), str(source), "--out", str(target)],
        check=True,
        capture_output=True,
    )


def publish_images(shots: dict[str, Shot], names: list[str]) -> None:
    for name in names:
        source = OUT / f"{name}.png"
        if name not in shots or not source.exists():
            fail(f"nothing to publish for {name}")
        shutil.copy2(source, REPO / "img" / f"{name}.png")
        print(f"img/{name}.png")
        for width, filename in site_assets(shots[name]):
            resize(source, width, SITE_ASSETS / filename)
            print(f"lamphere-labs/assets/img/{filename}")


def update_site_pages(shots: tuple[Shot, ...]) -> None:
    missing = [
        filename
        for shot in shots
        for _, filename in site_assets(shot)
        if not (SITE_ASSETS / filename).exists()
    ]
    if missing:
        fail(f"the gallery needs images that were never published: {missing}")
    gallery_page = replace_gallery(SITE_GALLERY_PAGE.read_text(), render_gallery(shots))
    page = SITE_PAGE.read_text()
    for shot in shots:
        if is_hero(shot):
            page = set_hero_alt(page, shot)
    SITE_GALLERY_PAGE.write_text(gallery_page)
    SITE_PAGE.write_text(page)
    print(f"lamphere-labs/{SITE_GALLERY_PAGE.relative_to(SITE)}: gallery")
    print(f"lamphere-labs/{SITE_PAGE.relative_to(SITE)}: hero alt text")


def site_text() -> str:
    pages = [path for path in SITE.rglob("*") if path.suffix in (".html", ".css", ".js", ".md")]
    return "\n".join(path.read_text() for path in pages if ".git" not in path.parts)


def remove_stale_images(shots: tuple[Shot, ...]) -> None:
    """Images for shots that no longer exist. All of these are tracked, so git can restore them."""
    text = site_text()
    for filename in stale_assets(tuple(path.name for path in SITE_ASSETS.iterdir()), text):
        (SITE_ASSETS / filename).unlink()
        print(f"removed lamphere-labs/assets/img/{filename}")
    readme = (REPO / "README.md").read_text()
    current = {shot.name for shot in shots}
    for path in (REPO / "img").glob("*.png"):
        if path.stem not in current and path.name not in readme:
            path.unlink()
            print(f"removed img/{path.name}")


def cmd_publish(args: argparse.Namespace) -> None:
    """Reviewed shots → img/, the site's resized copies and its gallery. Commits nothing."""
    if not SITE_PAGE.exists() or not SITE_GALLERY_PAGE.exists():
        fail(f"the website checkout isn't at {SITE}")
    shots = load_shots(read_manifest())
    by_name = {shot.name: shot for shot in shots}
    names = args.names or sorted(path.stem for path in OUT.glob("*.png") if not path.stem.endswith(".FAILED"))
    try:
        publish_images(by_name, names)
        update_site_pages(shots)
    except ManifestError as error:
        fail(str(error))
    remove_stale_images(shots)
    print(f"Check it locally: cd {SITE} && python3 -m http.server 8080, then open http://localhost:8080/tools/wickd/gallery/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)

    up = commands.add_parser("up", help="start a session (keeps running; background it)")
    up.add_argument("--tier", choices=("pro", "base"), required=True)
    up.set_defaults(func=cmd_up)

    run = commands.add_parser("run", help="take shots from shots.json")
    run.add_argument("names", nargs="*")
    run.add_argument("--all", action="store_true", help="every shot of this session's tier")
    run.set_defaults(func=cmd_run)

    js = commands.add_parser("js", help="run JS in the page (helpers on `shot`)")
    js.add_argument("code")
    js.set_defaults(func=cmd_js)

    go = commands.add_parser("goto", help="load a path and print what's on screen")
    go.add_argument("path")
    go.set_defaults(func=cmd_goto)

    capture = commands.add_parser("capture", help="capture the window as it is")
    capture.add_argument("name")
    capture.set_defaults(func=cmd_capture)

    commands.add_parser("prepare", help="fresh runs + checks, then the demo edits").set_defaults(func=cmd_prepare)
    commands.add_parser("check", help="check shots.json against the README").set_defaults(func=cmd_check)
    commands.add_parser("down", help="stop the session").set_defaults(func=cmd_down)

    publish = commands.add_parser("publish", help="reviewed shots → img/, the site's images and gallery")
    publish.add_argument("names", nargs="*")
    publish.set_defaults(func=cmd_publish)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
