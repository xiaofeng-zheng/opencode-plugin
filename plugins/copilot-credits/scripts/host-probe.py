#!/usr/bin/env python3
"""Isolated, no-model standard CLI probe. Never discovers a running service or reads auth.

python3 scripts/host-probe.py --binary /absolute/opencode --tui
All inputs are synthetic/disconnected. Artifacts are not live-account results.
"""
import argparse
import base64
import fcntl
import http.client
import http.server
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import signal
import struct
import subprocess
import termios
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True)
parser.add_argument("--expected-version", default="2.1.2", help="Exact standard CLI version under test")
parser.add_argument("--package", help="Installed package directory; defaults to the last successful pack:check consumer")
parser.add_argument("--tui", action="store_true")
parser.add_argument("--session", action="store_true", help="Create an empty synthetic session to check prompt.footer.status")
parser.add_argument("--synthetic-fixture", action="store_true", help="Inject the published finite TBB regression, never live credentials/network")
args = parser.parse_args()
if not re.fullmatch(r"2\.\d+\.\d+", args.expected_version):
    parser.error("--expected-version must be an exact OpenCode v2 version")
binary = Path(args.binary).resolve(strict=True)
if args.package is None:
    try:
        pack_check = json.loads((ROOT / ".artifacts/pack-check.json").read_text())
        if not pack_check.get("passed") or pack_check.get("name") != "opencode-copilot-credits":
            raise ValueError("No successful package verification")
        package = Path(pack_check["installedPackage"]).resolve(strict=True)
    except (OSError, ValueError, KeyError):
        parser.error("Run npm run pack:check first, or pass --package with the installed package directory")
else:
    package = Path(args.package).resolve(strict=True)
if Path("/etc/opencode").exists():
    raise SystemExit("System config discovery exists; isolation must be reviewed before this probe.")
run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
scratch = Path(os.environ.get("TMPDIR") or str(ROOT / ".test-sandbox"))
scratch.mkdir(parents=True, exist_ok=True)
sandbox = Path(tempfile.mkdtemp(prefix="opencode-copilot-host-", dir=scratch))
artifacts = ROOT / ".artifacts" / ("host-" + run_id)
artifacts.mkdir(parents=True)
for name in ["home", "tmp", "xdg-config", "data", "cache", "state", "config", "project"]:
    (sandbox / name).mkdir(parents=True)
password = secrets.token_urlsafe(32)  # Ephemeral sandbox-only auth; never written to artifacts.
load_package = package
if args.synthetic_fixture:
    load_package = sandbox / "fixture-plugin"
    load_package.mkdir()
    fixture = {"token_based_billing": True, "quota_reset_date_utc": "2026-11-01T00:00:00.000Z", "quota_snapshots": {"premium_interactions": {
        "entitlement": 13000, "quota_remaining": 807.7, "percent_remaining": 6.2, "credits_used": 14517,
        "overage_count": 0, "overage_entitlement": 100, "overage_permitted": False, "quota_reset_at": 0,
    }}}
    (load_package / "server.js").write_text(
        'import { setupServer } from ' + json.dumps((package / "dist/server.js").as_uri()) + ';\n'
        'export default { id: "copilot.credits.synthetic-probe", setup(ctx) { return setupServer(ctx, {\n'
        'account: async () => ({account: {key: "synthetic@github.com", host: "github.com", label: "SYNTHETIC fixture", token: "synthetic-not-a-credential"}}),\n'
        'now: () => 1792627200000, fetch: async () => Response.json(' + json.dumps(fixture) + ')\n'
        '}) }}\n')
    (load_package / "tui.js").write_text('export { default } from ' + json.dumps((package / "tui.js").as_uri()) + ';\n')
    (load_package / "rpc.js").write_text('export * from ' + json.dumps((package / "rpc.js").as_uri()) + ';\n')
env = {
    "PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "C.UTF-8",
    "HOME": str(sandbox / "home"), "OPENCODE_TEST_HOME": str(sandbox / "home"),
    "TMPDIR": str(sandbox / "tmp"), "XDG_CONFIG_HOME": str(sandbox / "xdg-config"),
    "XDG_DATA_HOME": str(sandbox / "data"), "XDG_CACHE_HOME": str(sandbox / "cache"),
    "XDG_STATE_HOME": str(sandbox / "state"), "OPENCODE_CONFIG_DIR": str(sandbox / "config"),
    "OPENCODE_DB": str(sandbox / "opencode.db"), "OPENCODE_PASSWORD": password,
    "OPENCODE_CONFIG_PROJECT_DISABLE": "true", "OPENCODE_DISABLE_CLAUDE_CODE": "true",
    "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_FILEWATCHER": "true", "OPENCODE_DISABLE_FFF": "true",
    "OPENCODE_CONFIG_CONTENT": json.dumps({"plugins": [str(load_package)], "autoupdate": False}),
    "OPENCODE_CLI_CONFIG_CONTENT": json.dumps({"plugins": [str(load_package)]}),
}
report = {"synthetic": True, "fixtureInjected": args.synthetic_fixture, "package": str(package), "binary": str(binary), "checks": {}, "requests": [], "blockedModelRequests": [], "modelRequestsForwarded": 0}
server = None
tui = None
proxy = None
try:
    version = subprocess.run([str(binary), "--version"], env=env, cwd=sandbox / "project", capture_output=True, text=True, timeout=20)
    (artifacts / "version.log").write_text(version.stdout + version.stderr)
    matched_version = re.search(r"\bv?(2\.\d+\.\d+)\b", version.stdout)
    assert version.returncode == 0 and matched_version and matched_version.group(1) == args.expected_version, "Unexpected standard CLI version"
    report["clientVersion"] = matched_version.group(1)
    stderr = open(artifacts / "server-stderr.log", "wb")
    server = subprocess.Popen([str(binary), "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], env=env, cwd=sandbox / "project", stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
    deadline = time.monotonic() + 45
    url = None
    lines = []
    while time.monotonic() < deadline and server.poll() is None:
        if not select.select([server.stdout], [], [], 0.2)[0]:
            continue
        line = server.stdout.readline().decode("utf-8", "replace")
        lines.append(line)
        try:
            url = json.loads(line).get("url")
        except (ValueError, AttributeError):
            continue
        if url:
            break
    (artifacts / "server-stdout.log").write_text("".join(lines))
    assert url and urllib.parse.urlparse(url).hostname == "127.0.0.1", "Private server did not start"
    port = urllib.parse.urlparse(url).port
    authorization = "Basic " + base64.b64encode(("opencode:" + password).encode()).decode()

    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *unused):
            pass

        def forward(self):
            path = urllib.parse.urlparse(self.path).path
            report["requests"].append(self.command + " " + path)
            if self.command == "POST" and re.search(r"/(prompt|generate|command|synthetic|compact)(/|$)", path):
                report["blockedModelRequests"].append(path)
                self.send_error(403, "No-model probe")
                return
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
            try:
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                headers = {key: value for key, value in self.headers.items() if key.lower() not in ["host", "connection", "transfer-encoding"]}
                conn.request(self.command, self.path, body=body or None, headers=headers)
                response = conn.getresponse()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ["connection", "transfer-encoding"]:
                        self.send_header(key, value)
                self.send_header("Connection", "close")
                self.end_headers()
                while True:
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError, http.client.IncompleteRead):
                pass
            finally:
                conn.close()
                self.close_connection = True

        do_GET = do_POST = do_DELETE = do_PATCH = do_PUT = forward

    proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    proxy.daemon_threads = True
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    endpoint = "http://127.0.0.1:" + str(proxy.server_port)
    query = urllib.parse.urlencode({"location[directory]": str(sandbox / "project")})

    def request(path, body=None):
        req = urllib.request.Request(endpoint + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": authorization, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)

    info = request("/api/info")
    assert info["version"] == args.expected_version, "Private server version must match the requested test version"
    (artifacts / "info.json").write_text(json.dumps(info, indent=2))
    plugins = request("/api/plugin?" + query)
    (artifacts / "plugins.json").write_text(json.dumps(plugins, indent=2))
    result = request("/api/rpc/copilot.credits/get?" + query, {"input": {"force": True}})
    (artifacts / "rpc.json").write_text(json.dumps(result, indent=2))
    unauthenticated = urllib.request.Request(endpoint + "/api/rpc/copilot.credits/get?" + query,
                                            data=b'{"input":{}}', headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(unauthenticated, timeout=10)
        raise AssertionError("RPC unexpectedly accepted an unauthenticated request")
    except urllib.error.HTTPError as error:
        assert error.code == 401
        report["checks"]["rpcAuthentication"] = "passed: HTTP 401 without sandbox authentication"
    if args.synthetic_fixture:
        assert result["output"]["used"] == 12192.3 and result["output"]["usedPercent"] == 93.8
        assert result["output"]["absoluteCreditsUsed"] == 14517
        assert result["output"]["resetAt"] == "2026-11-01T00:00:00.000Z", "Zero reset sentinel must use the root date"
        report["checks"]["resetFallbackRpc"] = "passed: zero sentinel -> 2026-11-01T00:00:00.000Z"
        report["checks"]["packagedServerRpc"] = "passed: injected synthetic regression"
    else:
        assert result["output"]["status"] == "disconnected" and result["output"]["used"] is None
        report["checks"]["packagedServerRpc"] = "passed: disconnected, not zero"
    if args.tui:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
        tui_args = [str(binary), "--server", endpoint]
        if args.session:
            session = request("/api/session", {"title": "Synthetic no-model footer probe", "location": {"directory": str(sandbox / "project")}})
            tui_args.extend(["--session", session["data"]["id"]])
        tui = subprocess.Popen(tui_args, env=env, cwd=sandbox / "project", stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        transcript = bytearray()

        def collect(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if not select.select([master], [], [], 0.1)[0]:
                    continue
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                transcript.extend(chunk)
                # Standard terminal capability queries: answer only, never user/model input.
                if b"\x1b[6n" in chunk:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in chunk:
                    os.write(master, b"\x1b[?1;2c")
            (artifacts / "tui.ansi").write_bytes(transcript)

        collect(10)
        os.write(master, b"\x1b")
        collect(1)
        # Do not submit an unregistered slash command as a prompt.
        boot = transcript.decode("utf-8", "replace")
        if "Plugin failed" in boot:
            raise RuntimeError("Packaged TUI plugin failed to load; no slash input submitted")
        if "Copilot:" not in boot:
            raise RuntimeError("Copilot footer is not rendered; no slash input submitted")
        os.write(master, b"/copilot")
        collect(2)
        os.write(master, b"\r")
        collect(5)
        text = transcript.decode("utf-8", "replace")
        plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        (artifacts / "tui-text.txt").write_text(plain)
        expected_footer = "12,192.3 / 13,000 AI credits used (93.8%)" if args.synthetic_fixture else "Copilot: unknown"
        expected_detail = "Absolute consumption:" if args.synthetic_fixture else "No Copilot account connected"
        report["checks"]["promptFooter" if args.session else "homeFooter"] = "passed" if expected_footer in plain else "unverified"
        report["checks"]["slashDetails"] = "passed" if expected_detail in plain else "unverified"
        if args.synthetic_fixture:
            assert "Reset (UTC): 2026-11-01T00:00:00.000Z" in plain, "Rendered details must show the root reset date"
            assert "1970-01-01" not in plain, "Rendered details must not show the absent sentinel as 1970"
            report["checks"]["resetFallbackDetails"] = "passed: 2026-11-01T00:00:00.000Z, no 1970"
        os.write(master, b"\x1b")
        collect(1)
        os.write(master, b"/exit")
        collect(1)
        os.write(master, b"\r")
        collect(3)
        if tui.poll() is None:
            os.write(master, b"\x03\x03")
            collect(2)
        try:
            tui.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        report["checks"]["tuiExitCode"] = tui.poll()
        os.close(master)
    report["checks"]["noModelRequests"] = len(report["blockedModelRequests"]) == 0
    assert report["checks"]["noModelRequests"], "Unexpected model request attempted (proxy blocked it)"
    assert "unverified" not in report["checks"].values(), "A required visual check remains unverified"
finally:
    if tui and tui.poll() is None:
        os.killpg(tui.pid, signal.SIGTERM)
        tui.wait(timeout=10)
    if proxy:
        proxy.shutdown()
        proxy.server_close()
    if server:
        if server.stdin:
            server.stdin.close()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGTERM)
            server.wait(timeout=10)
        report["checks"]["serverExitCode"] = server.returncode
    owned_log = sandbox / "data/opencode/log/opencode.log"
    if owned_log.exists():
        (artifacts / "host.log").write_text(owned_log.read_text().replace(password, "[ephemeral-auth-redacted]"))
    (artifacts / "report.json").write_text(json.dumps(report, indent=2))
    print(artifacts)

# Check after cleanup so a failed exit still leaves complete diagnostic artifacts.
assert report["checks"].get("serverExitCode") == 0, "Private server must exit with code zero"
if args.tui:
    assert report["checks"].get("tuiExitCode") == 0, "TUI must exit with code zero without forced cleanup"
