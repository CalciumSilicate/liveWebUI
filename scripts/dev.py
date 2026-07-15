from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
MEDIAMTX_DIR = VENDOR / "mediamtx"
MEDIAMTX_EXE = MEDIAMTX_DIR / ("mediamtx.exe" if os.name == "nt" else "mediamtx")
MEDIAMTX_CONFIG = MEDIAMTX_DIR / "mediamtx.local.yml"
FFMPEG_EXE = VENDOR / "ffmpeg" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")

DEFAULT_MEDIAMTX_VERSION = "1.17.1"
DEFAULT_FFMPEG_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


class ManagedProcess:
    def __init__(self, name: str, command: list[str], env: dict[str, str] | None = None) -> None:
        self.name = name
        self.command = command
        self.env = env
        self.process: subprocess.Popen[str] | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        self.process = subprocess.Popen(
            self.command,
            cwd=ROOT,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.thread = threading.Thread(target=self._pipe_output, daemon=True)
        self.thread.start()
        print(f"[dev] started {self.name} pid={self.process.pid}")

    def _pipe_output(self) -> None:
        assert self.process is not None
        assert self.process.stdout is not None
        for line in self.process.stdout:
            print(f"[{self.name}] {line}", end="", flush=True)

    def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        print(f"[dev] stopping {self.name} pid={self.process.pid}")
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            print(f"[dev] killing {self.name} pid={self.process.pid}")
            self.process.kill()
            self.process.wait(timeout=5)


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"[dev] {' '.join(command)}")
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def npm_command() -> str:
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm not found. Install Node.js first.")
    return npm


def node_command() -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node not found. Install Node.js first.")
    return node


def local_ipv4() -> str:
    if os.name == "nt":
        try:
            output = subprocess.check_output(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "Get-NetIPAddress -AddressFamily IPv4 | "
                    "Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | "
                    "Select-Object -ExpandProperty IPAddress",
                ],
                cwd=ROOT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            ips = [line.strip() for line in output.splitlines() if line.strip()]
            for ip in ips:
                if ip.startswith("192.168."):
                    return ip
            if ips:
                return ips[0]
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass

    candidates: list[str] = []
    try:
        host = socket.gethostname()
        for _, _, _, _, sockaddr in socket.getaddrinfo(host, None, socket.AF_INET):
            ip = sockaddr[0]
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                candidates.append(ip)
    except socket.gaierror:
        pass
    for ip in candidates:
        if ip.startswith("192.168."):
            return ip
    if candidates:
        return candidates[0]
    return "127.0.0.1"


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"[dev] downloading {url}")
    with urllib.request.urlopen(url) as response, target.open("wb") as file:
        shutil.copyfileobj(response, file)


def fetch_mediamtx(version: str = DEFAULT_MEDIAMTX_VERSION) -> None:
    if MEDIAMTX_EXE.exists():
        return
    if os.name != "nt":
        raise RuntimeError("Auto-fetch MediaMTX is currently implemented for Windows dev only.")

    archive = VENDOR / "_downloads" / f"mediamtx_v{version}_windows_amd64.zip"
    url = f"https://github.com/bluenviron/mediamtx/releases/download/v{version}/{archive.name}"
    download(url, archive)
    if MEDIAMTX_DIR.exists():
        shutil.rmtree(MEDIAMTX_DIR)
    MEDIAMTX_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(MEDIAMTX_DIR)
    (MEDIAMTX_DIR / "VERSION").write_text(version, encoding="utf-8")
    print(f"[dev] MediaMTX ready at {MEDIAMTX_EXE}")


def fetch_ffmpeg(url: str = DEFAULT_FFMPEG_URL) -> None:
    if FFMPEG_EXE.exists() or command_exists("ffmpeg"):
        return
    if os.name != "nt":
        raise RuntimeError("ffmpeg not found. Install ffmpeg or add it to PATH.")

    archive = VENDOR / "_downloads" / "ffmpeg.zip"
    extract_dir = VENDOR / "_downloads" / "ffmpeg-extract"
    download(url, archive)
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(extract_dir)

    ffmpeg = next(extract_dir.rglob("ffmpeg.exe"), None)
    ffprobe = next(extract_dir.rglob("ffprobe.exe"), None)
    if ffmpeg is None:
        raise RuntimeError("ffmpeg.exe not found in downloaded archive.")
    FFMPEG_EXE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ffmpeg, FFMPEG_EXE)
    if ffprobe is not None:
        shutil.copy2(ffprobe, FFMPEG_EXE.parent / "ffprobe.exe")
    (VENDOR / "ffmpeg" / "SOURCE_URL").write_text(url, encoding="utf-8")
    print(f"[dev] FFmpeg ready at {FFMPEG_EXE}")


def ensure_dependencies(skip_install: bool) -> None:
    node_command()
    npm = npm_command()
    if skip_install:
        return
    if not (ROOT / "node_modules").exists():
        run([npm, "install"])
    if not (ROOT / "web" / "node_modules").exists():
        run([npm, "--prefix", "web", "install"])


def ensure_static_build(skip_static_build: bool) -> None:
    if skip_static_build:
        return
    if not (ROOT / "web" / "dist" / "index.html").exists():
        run([npm_command(), "--prefix", "web", "run", "build"])


def write_mediamtx_config(args: argparse.Namespace, public_hosts: list[str]) -> None:
    MEDIAMTX_DIR.mkdir(parents=True, exist_ok=True)
    hosts = "\n".join(f"  - {host}" for host in public_hosts)
    config = f"""logLevel: info

readTimeout: 10s
writeTimeout: 10s
writeQueueSize: 512

authMethod: http
authHTTPAddress: http://127.0.0.1:{args.app_port}/internal/mediamtx/auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

api: true
apiAddress: :9997
apiAllowOrigins: ['*']

rtmp: true
rtmpAddress: :{args.rtmp_port}

hls: true
hlsAddress: :{args.hls_port}
hlsAllowOrigins: ['*']
hlsAlwaysRemux: false
hlsVariant: fmp4
hlsSegmentCount: 6
hlsSegmentDuration: 2s
hlsPartDuration: 500ms
hlsMuxerCloseAfter: 20s

webrtc: true
webrtcAddress: :42113
webrtcAllowOrigins: ['*']
webrtcLocalUDPAddress: :42114
webrtcLocalTCPAddress: :42115
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts:
{hosts}

paths:
  all:
    source: publisher
"""
    MEDIAMTX_CONFIG.write_text(config, encoding="utf-8")


def powershell_stop_existing() -> None:
    if os.name != "nt":
        return
    exclude_pids = sorted({os.getpid(), os.getppid()})
    exclude_literal = ",".join(str(pid) for pid in exclude_pids)
    root_literal = str(ROOT).replace("'", "''")
    mediamtx_config_literal = str(MEDIAMTX_CONFIG).replace("'", "''")
    ffmpeg_literal = str(FFMPEG_EXE).replace("'", "''")
    script = rf"""
$ErrorActionPreference = 'SilentlyContinue'
$exclude = @($PID,{exclude_literal})
$root = '{root_literal}'
$mediamtxConfig = '{mediamtx_config_literal}'
$ffmpeg = '{ffmpeg_literal}'
    $ports = @(42110,42111,42112,42113,42115,5278,8888,8889,9997)
$pids = New-Object 'System.Collections.Generic.HashSet[int]'

foreach ($port in $ports) {{
  Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object {{
    [void]$pids.Add([int]$_.OwningProcess)
  }}
}}

Get-CimInstance Win32_Process | Where-Object {{
  $_.CommandLine -and (
    $_.CommandLine.Contains($mediamtxConfig) -or
    $_.CommandLine.Contains($ffmpeg) -or
    ($_.CommandLine.Contains($root) -and $_.CommandLine.Contains('src/server.ts')) -or
    ($_.CommandLine.Contains($root) -and $_.CommandLine.Contains('node_modules') -and $_.CommandLine.Contains('vite'))
  )
}} | ForEach-Object {{
  [void]$pids.Add([int]$_.ProcessId)
}}

foreach ($targetPid in $pids) {{
  if ($exclude -contains [int]$targetPid) {{
    continue
  }}
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid"
  if ($process) {{
    Write-Output "[dev] stopping existing PID=$($process.ProcessId) $($process.Name)"
    Stop-Process -Id $process.ProcessId -Force
  }}
}}
"""
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], cwd=ROOT)


def build_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    ffmpeg = shutil.which("ffmpeg") or str(FFMPEG_EXE)
    env.update(
        {
            "ADMIN_PASSWORD": args.admin_password,
            "SESSION_SECRET": args.session_secret,
            "APP_PORT": str(args.app_port),
            "WEB_DIST": str(ROOT / "web" / "dist"),
            "MEDIA_API_URL": "http://127.0.0.1:9997",
            "MEDIA_HLS_ORIGIN": f"http://127.0.0.1:{args.hls_port}",
            "MEDIA_RTMP_ORIGIN": f"rtmp://127.0.0.1:{args.rtmp_port}",
            "MEDIA_RTSP_ORIGIN": "rtsp://127.0.0.1:8554",
            "PUBLIC_WEBRTC_PORT": "42113",
            "FFMPEG_BIN": ffmpeg,
            "RECORDINGS_DIR": str(ROOT / "data" / "recordings"),
        }
    )
    return env


def main() -> int:
    parser = argparse.ArgumentParser(description="Run liveWebUI dev stack in one terminal.")
    parser.add_argument("--admin-password", default="callmegpt")
    parser.add_argument("--session-secret", default="dev-session-secret-callmegpt-local")
    parser.add_argument("--app-port", type=int, default=42110)
    parser.add_argument("--web-port", type=int, default=5278)
    parser.add_argument("--rtmp-port", type=int, default=42111)
    parser.add_argument("--hls-port", type=int, default=42112)
    parser.add_argument("--public-webrtc-hosts", default="")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--skip-static-build", action="store_true")
    parser.add_argument("--skip-fetch", action="store_true")
    parser.add_argument("--kill-existing", action="store_true", default=True)
    parser.add_argument("--no-kill-existing", action="store_false", dest="kill_existing")
    parser.add_argument("--stop-only", action="store_true")
    args = parser.parse_args()

    if os.name == "nt":
        os.system("chcp 65001 > nul")

    if args.kill_existing:
        powershell_stop_existing()

    if args.stop_only:
        return 0

    ensure_dependencies(args.skip_install)
    ensure_static_build(args.skip_static_build)
    if not args.skip_fetch:
        fetch_mediamtx()
        fetch_ffmpeg()

    lan_ip = local_ipv4()
    hosts = [host.strip() for host in args.public_webrtc_hosts.split(",") if host.strip()]
    if not hosts:
        hosts = ["127.0.0.1", "localhost", lan_ip]
    write_mediamtx_config(args, hosts)

    env = build_env(args)
    npm = npm_command()
    processes = [
        ManagedProcess("mediamtx", [str(MEDIAMTX_EXE), str(MEDIAMTX_CONFIG)]),
        ManagedProcess("backend", [npm, "run", "dev:backend"], env=env),
        ManagedProcess(
            "frontend",
            [npm, "--prefix", "web", "run", "dev", "--", "--host", "0.0.0.0", "--port", str(args.web_port)],
            env={**os.environ, "APP_API_PORT": str(args.app_port)},
        ),
    ]

    stopping = False

    def stop_all() -> None:
        nonlocal stopping
        if stopping:
            return
        stopping = True
        for proc in reversed(processes):
            proc.stop()

    try:
        for proc in processes:
            proc.start()
        print("")
        print("[dev] liveWebUI is running")
        print(f"[dev] Admin/backend: http://{lan_ip}:{args.app_port}/admin")
        print(f"[dev] Frontend dev:  http://{lan_ip}:{args.web_port}")
        print(f"[dev] Health:        http://{lan_ip}:{args.app_port}/health")
        print(f"[dev] RTMP:          rtmp://{lan_ip}:{args.rtmp_port}/<slug>?user=<slug>&pass=<publishPassword>")
        print(f"[dev] Password:      {args.admin_password}")
        print("[dev] Press Ctrl+C to stop all services.")

        while True:
            for proc in processes:
                if proc.process is not None and proc.process.poll() is not None:
                    print(f"[dev] {proc.name} exited with code {proc.process.returncode}")
                    stop_all()
                    return int(proc.process.returncode or 1)
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[dev] Ctrl+C received")
        stop_all()
        return 0
    finally:
        stop_all()


if __name__ == "__main__":
    raise SystemExit(main())
