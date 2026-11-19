#!/usr/bin/env python3
"""
HERDCODE Bridge — runs on the Codex host (usually Hades, your laptop).

Why this exists
---------------
Codex is a host program, not a phone program: it needs a repo checkout, a
shell, and a local model server. Ollama likewise lives on your GPU boxes.
The Fold 6 app is therefore a cockpit, and this bridge is the engine room:

    Fold 6 app ──HTTP/SSE (Tailscale only)──► herd_bridge.py on Hades
                                                  │
                                                  ├─► codex exec --oss --json
                                                  │     └─► Ollama on Hades / a Herd node
                                                  └─► Herd status: Ollama /api/tags + /api/ps
                                                        on every upstream you list

The app also talks to Ollama / LiteLLM *directly* for plain chat — the bridge
is only required for Codex agent runs.

Configuration (environment)
---------------------------
  HERD_TOKEN        REQUIRED. Shared secret; the app sends it as
                    `Authorization: Bearer <token>` (or X-Herd-Token).
                    Generate one:  python3 -c "import secrets; print(secrets.token_hex(24))"
  HERD_BIND         Interface to bind. Default 0.0.0.0 — set this to the
                    host's Tailscale IP (100.x.x.x) so the bridge is not
                    even reachable from the LAN if you don't want it to be.
  HERD_PORT         Default 8765.
  HERD_REPOS_ROOT   Directory whose immediate subdirectories (and itself)
                    are the repos Codex may work in. Default ~/workspace.
                    A run's `repo` must resolve inside this root. No escapes.
  HERD_UPSTREAMS    Comma-separated Ollama base URLs for herd status, e.g.
                    "http://127.0.0.1:11434,http://x99-box:11434".
                    Default http://127.0.0.1:11434
  CODEX_BIN         Path/name of the codex binary. Default "codex".
  HERD_RUN_TIMEOUT  Seconds before a Codex run is killed. Default 1800.

Safety posture
--------------
  * Token required on every route except /health's `ok` flag (which still
    reports no versions or paths without the token).
  * One Codex run at a time; a second POST gets 409.
  * Default sandbox is `read-only`. `workspace-write` must be requested
    explicitly per run from the app. `danger-full-access` is refused
    unless HERD_ALLOW_FULL=1 is set in the bridge's environment.
  * Codex is invoked as an argv list — never through a shell — and the
    prompt travels as a single argv argument.
  * Bind it to Tailscale. Never port-forward it. Ollama and LiteLLM have
    no real auth of their own; the tailnet is the perimeter.

Stdlib only. Python 3.10+. No pip installs.
"""

import hmac
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

TOKEN = os.environ.get("HERD_TOKEN", "")
BIND = os.environ.get("HERD_BIND", "0.0.0.0")
PORT = int(os.environ.get("HERD_PORT", "8765"))
REPOS_ROOT = Path(os.environ.get("HERD_REPOS_ROOT", str(Path.home() / "workspace"))).expanduser()
UPSTREAMS = [u.strip().rstrip("/") for u in
             os.environ.get("HERD_UPSTREAMS", "http://127.0.0.1:11434").split(",") if u.strip()]
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
RUN_TIMEOUT = int(os.environ.get("HERD_RUN_TIMEOUT", "1800"))
ALLOW_FULL = os.environ.get("HERD_ALLOW_FULL", "0") == "1"

_current = {"proc": None, "repo": None, "started": None}
_lock = threading.Lock()


def log(*a):
    print("[herd-bridge]", *a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def fetch_json(url, timeout=4):
    """GET a JSON document; return (ok, data_or_error_str)."""
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:  # connection refused, timeout, bad JSON — all just "down"
        return False, str(e)


def upstream_status(url):
    ok_tags, tags = fetch_json(url + "/api/tags")
    ok_ps, ps = fetch_json(url + "/api/ps")
    models = []
    if ok_tags and isinstance(tags, dict):
        models = [m.get("name") for m in tags.get("models", []) if m.get("name")]
    loaded = []
    if ok_ps and isinstance(ps, dict):
        loaded = [m.get("name") for m in ps.get("models", []) if m.get("name")]
    return {"url": url, "up": ok_tags, "models": models, "loaded": loaded,
            "error": None if ok_tags else str(tags)}


def list_repos():
    """Repos = REPOS_ROOT itself plus its immediate subdirs that look like
    projects (contain a .git dir/file or a common manifest). Returned paths
    are relative to the root; '' means the root itself."""
    out = []
    root = REPOS_ROOT.resolve()
    if not root.is_dir():
        return out

    def describe(p, rel):
        branch = None
        if (p / ".git").exists():
            try:
                r = subprocess.run(["git", "-C", str(p), "rev-parse", "--abbrev-ref", "HEAD"],
                                   capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    branch = r.stdout.strip() or None
            except Exception:
                pass
        return {"name": p.name, "path": rel, "git": (p / ".git").exists(), "branch": branch}

    if (root / ".git").exists():
        out.append(describe(root, ""))
    try:
        children = sorted((c for c in root.iterdir() if c.is_dir()), key=lambda c: c.name.lower())
    except OSError:
        children = []
    markers = (".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "build.gradle")
    for c in children:
        if c.name.startswith("."):
            continue
        if any((c / m).exists() for m in markers):
            out.append(describe(c, c.name))
    return out


def resolve_repo(rel):
    """Resolve a client-supplied repo path strictly inside REPOS_ROOT."""
    root = REPOS_ROOT.resolve()
    target = (root / (rel or "")).resolve()
    if target != root and root not in target.parents:
        return None
    if not target.is_dir():
        return None
    return target


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------
    def log_message(self, fmt, *args):  # quieter than default
        log(self.address_string(), fmt % args)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, X-Herd-Token, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if not TOKEN:
            return False
        given = ""
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            given = auth[7:].strip()
        given = given or self.headers.get("X-Herd-Token", "")
        return hmac.compare_digest(given, TOKEN)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    # -- GET routes ---------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            if not self._authed():
                # Unauthenticated health reveals nothing but liveness.
                return self._json(200, {"ok": True, "auth": False})
            codex_path = shutil.which(CODEX_BIN) if "/" not in CODEX_BIN else (
                CODEX_BIN if os.path.exists(CODEX_BIN) else None)
            version = None
            if codex_path:
                try:
                    r = subprocess.run([CODEX_BIN, "--version"], capture_output=True,
                                       text=True, timeout=8)
                    version = (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr) else None
                except Exception as e:
                    version = f"error: {e}"
            return self._json(200, {
                "ok": True, "auth": True,
                "codex_bin": CODEX_BIN, "codex_found": bool(codex_path),
                "codex_version": version,
                "repos_root": str(REPOS_ROOT),
                "upstreams": UPSTREAMS,
                "run_active": _current["proc"] is not None and _current["proc"].poll() is None,
                "allow_full": ALLOW_FULL,
            })
        if not self._authed():
            return self._json(401, {"error": "bad or missing token"})
        if path == "/herd/status":
            return self._json(200, {"nodes": [upstream_status(u) for u in UPSTREAMS]})
        if path == "/repos":
            return self._json(200, {"root": str(REPOS_ROOT), "repos": list_repos()})
        return self._json(404, {"error": "no such route"})

    # -- POST routes --------------------------------------------------------
    def do_POST(self):
        path = urlparse(self.path).path
        if not self._authed():
            return self._json(401, {"error": "bad or missing token"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception as e:
            return self._json(400, {"error": f"bad JSON body: {e}"})

        if path == "/codex/cancel":
            with _lock:
                proc = _current["proc"]
            if proc and proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGTERM)
                except Exception:
                    pass
                return self._json(200, {"ok": True, "cancelling": True})
            return self._json(200, {"ok": True, "cancelling": False})

        if path == "/codex/run":
            return self._codex_run(body)

        return self._json(404, {"error": "no such route"})

    # -- the Codex run itself ------------------------------------------------
    def _codex_run(self, body):
        repo = resolve_repo(body.get("repo", ""))
        if repo is None:
            return self._json(400, {"error": "repo not found under HERD_REPOS_ROOT"})
        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            return self._json(400, {"error": "prompt is empty"})
        if len(prompt) > 100_000:
            return self._json(400, {"error": "prompt too large"})
        model = (body.get("model") or "").strip()
        sandbox = (body.get("sandbox") or "read-only").strip()
        if sandbox not in ("read-only", "workspace-write", "danger-full-access"):
            return self._json(400, {"error": f"unknown sandbox: {sandbox}"})
        if sandbox == "danger-full-access" and not ALLOW_FULL:
            return self._json(403, {"error": "danger-full-access disabled on the bridge "
                                             "(set HERD_ALLOW_FULL=1 to allow it)"})
        if shutil.which(CODEX_BIN) is None and not os.path.exists(CODEX_BIN):
            return self._json(503, {"error": f"codex binary not found: {CODEX_BIN!r}. "
                                             "Install Codex on this host first."})

        with _lock:
            if _current["proc"] is not None and _current["proc"].poll() is None:
                return self._json(409, {"error": "a Codex run is already in progress",
                                        "repo": _current["repo"],
                                        "started": _current["started"]})
            # Build the argv list. --oss = local provider (Ollama); the bridge
            # always runs Codex against the local herd, never OpenAI cloud,
            # unless the client explicitly passes use_oss=false AND the host
            # config opts in — there is deliberately no such opt-in here.
            cmd = [CODEX_BIN, "exec", "--json", "--oss",
                   "--skip-git-repo-check",
                   "-C", str(repo), "--sandbox", sandbox]
            if model:
                cmd += ["-m", model]
            cmd += ["--", prompt]

            # SSE response starts now; everything after is events.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            # No Content-Length on a stream — the close IS the end marker,
            # so the phone's fetch reader must see the connection drop
            # after the `done` event instead of waiting on keep-alive.
            self.send_header("Connection", "close")
            self.close_connection = True
            self._cors()
            self.end_headers()

            def send(event, data):
                payload = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
                self.wfile.write(payload)
                self.wfile.flush()

            try:
                proc = subprocess.Popen(cmd, cwd=str(repo), stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1)
            except Exception as e:
                send("error", {"error": f"failed to launch codex: {e}"})
                return
            _current.update(proc=proc, repo=str(repo), started=time.time())
            send("started", {"cmd": cmd[:-1] + ["<prompt>"], "repo": str(repo),
                             "model": model or "(codex --oss default)",
                             "sandbox": sandbox})

        # stderr is drained on a side thread so a chatty Codex can't deadlock
        # on a full pipe while we read stdout.
        stderr_lines = []

        def drain_stderr():
            try:
                for line in proc.stderr:
                    stderr_lines.append(line.rstrip("\n"))
            except Exception:
                pass

        t = threading.Thread(target=drain_stderr, daemon=True)
        t.start()

        deadline = time.time() + RUN_TIMEOUT
        timed_out = False
        try:
            for line in proc.stdout:
                if time.time() > deadline:
                    timed_out = True
                    proc.kill()
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    send("raw", {"text": line})
                    continue
                send("codex", obj)
        except (BrokenPipeError, ConnectionResetError):
            # Phone went away (fold closed, app killed). Stop the run rather
            # than leaving an agent writing to a repo unsupervised.
            try:
                proc.terminate()
            except Exception:
                pass
        finally:
            try:
                rc = proc.wait(timeout=10)
            except Exception:
                proc.kill()
                rc = proc.wait()
            for s in stderr_lines[-50:]:
                if s.strip():
                    send("stderr", {"text": s})
            send("done", {"exit_code": rc, "timed_out": timed_out,
                          "repo": str(repo)})
            with _lock:
                if _current["proc"] is proc:
                    _current.update(proc=None, repo=None, started=None)


def main():
    if not TOKEN:
        log("FATAL: HERD_TOKEN is not set. Refusing to start an unauthenticated bridge.")
        log("  export HERD_TOKEN=$(python3 -c \"import secrets; print(secrets.token_hex(24))\")")
        sys.exit(2)
    if BIND == "0.0.0.0":
        log("WARNING: binding 0.0.0.0 — reachable on LAN as well as tailnet. "
            "Set HERD_BIND to this host's Tailscale IP to restrict it.")
    log(f"repos root: {REPOS_ROOT}")
    log(f"upstreams:  {', '.join(UPSTREAMS)}")
    log(f"codex bin:  {CODEX_BIN} (found: {bool(shutil.which(CODEX_BIN))})")
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    log(f"listening on http://{BIND}:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
