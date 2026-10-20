"""User controls and the supervised background sync loop."""

import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import uuid
from collections import Counter
from collections.abc import Callable
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

RETRY_FIRST = 15  # seconds before retrying a failed round, doubling per failure...
RETRY_MAX = 120  # ...up to two minutes, so one bad round never parks sync for long
CREDENTIAL_RETRY_MAX = 3600  # a round that must fetch the credential again: finite budget
LOCKED_RETRY = 5  # another local writer held the database; it lets go in seconds


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-")
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out)
            out.write("\n")
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def update_preferences(data: Path, update: Callable[[dict], None]) -> dict:
    """Merge current prefs under a short lock; callers do network/Keychain work first."""
    data.mkdir(parents=True, exist_ok=True)
    with (data / "preferences.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        prefs = read_json(data / "background.json")
        revision = prefs.get("revision", 0)
        update(prefs)
        prefs["revision"] = revision + 1 if isinstance(revision, int) else 1
        write_json(data / "background.json", prefs)
        return prefs


def keychain_account(data: Path, hub_url: str) -> str:
    return hashlib.sha256(f"{data.resolve()}\n{hub_url.rstrip('/')}".encode()).hexdigest()


class CredentialError(RuntimeError):
    """A credential lifecycle failure safe to display without native diagnostics."""


class CredentialLockError(CredentialError):
    """Another native credential installation is in progress."""


@contextmanager
def credential_lock(data: Path):
    """Serialize native credential changes through their preference commit."""
    data.mkdir(parents=True, exist_ok=True)
    with (data / "credentials.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CredentialLockError(
                "another device credential update is in progress; retry"
            ) from None
        yield


def save_credential(data: Path, account: str, token: str, previous: str | None, update) -> None:
    """Caller holds credential_lock; restore native state if preferences cannot commit."""
    from .credentials import delete_token, read_token, store_token

    if token != previous:
        store_token(account, token)
    try:
        update_preferences(data, update)
    except Exception:  # noqa: BLE001 - all failed preference commits need native rollback
        if token != previous:
            try:
                if read_token(account) != token:
                    raise CredentialError("device credential changed")
                if previous is None:
                    delete_token(account)
                else:
                    store_token(account, previous)
            except Exception:  # noqa: BLE001 - never expose native rollback diagnostics
                raise CredentialError(
                    "could not install the device credential; local credential rollback failed"
                ) from None
        raise CredentialError("could not install the device credential") from None


def status(data: Path) -> dict:
    prefs = read_json(data / "background.json")
    current = read_json(data / "background-status.json")
    running = False
    try:
        with (data / "background.lock").open("r") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                running = True
                if sys.platform == "darwin":
                    pid = lock.read().strip()
                    if pid.isdigit():
                        proc = subprocess.run(
                            ["/bin/ps", "-o", "state=", "-p", pid],
                            capture_output=True,
                            text=True,
                            timeout=2,
                            check=False,
                        )
                        running = proc.returncode == 0 and not any(
                            state in proc.stdout for state in ("T", "Z")
                        )
    except FileNotFoundError:
        pass
    return {
        "enabled": prefs.get("enabled", False),
        "running": running,
        "state": current.get("state", "starting") if running else "stopped",
        "last_success": current.get("last_success"),
        "last_error": current.get("last_error"),
        "last_attempt": current.get("last_attempt"),
        "stats": current.get("stats"),
    }


def request_sync(data: Path, *, timeout: float = 60) -> dict | None:
    """Ask the enabled runner for a fresh round, without reading its credential."""
    if os.environ.get("SOMA_HUB_TOKEN") or os.environ.get("SOMA_HUB_URL"):
        return None
    current = status(data)
    if not current["enabled"] or not current["running"]:
        return None
    if read_json(data / "background-status.json").get("sync_requests") != 1:
        raise ValueError("restart the background sync runner to enable delegated sync")
    deadline = time.monotonic() + timeout
    request_id = uuid.uuid4().hex
    request = data / "sync-request.json"
    result = data / "sync-result.json"
    fd = os.open(data / "sync-request.lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "r+") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("timed out waiting for background sync") from None
                time.sleep(0.1)
        try:
            write_json(request, {"id": request_id})
            while time.monotonic() < deadline:
                reply = read_json(result)
                if reply.get("id") == request_id:
                    if reply.get("error"):
                        raise ValueError("background sync failed: " + reply["error"])
                    return reply["stats"]
                time.sleep(0.1)
            raise ValueError("timed out waiting for background sync; the runner may still finish")
        finally:
            request.unlink(missing_ok=True)
            result.unlink(missing_ok=True)


def _sync_request(data: Path) -> str | None:
    request_id = read_json(data / "sync-request.json").get("id")
    if request_id and read_json(data / "sync-result.json").get("id") != request_id:
        return request_id
    return None


def command(args, data: Path) -> int:
    from . import _get_state, load_config

    action = args.background_command
    if action == "run":
        return run(data, args.poll)
    if action in {"enable", "disable"}:
        changes = {"enabled": action == "enable"}
        token = None
        if action == "enable":
            if args.hub_url:
                previous = load_config(data, resolve_auth=False)["hub_url"]
                endpoint = os.environ.get("SOMA_HUB_URL", args.hub_url).rstrip("/")
                db = data / "soma.db"
                if (
                    endpoint != previous
                    and db.exists()
                    and (_get_state(db, "last_push") or _get_state(db, "last_pull"))
                ):
                    raise ValueError("hub changed; use a fresh data directory for a different hub")
                changes["hub_url"] = args.hub_url.rstrip("/")
            if args.token_command is not None:
                if not args.token_command.strip():
                    raise ValueError("credential command must not be empty")
                changes["token_cmd"] = args.token_command
            if args.token_stdin:
                from .credentials import read_token

                cfg = load_config(data, resolve_auth=False)
                endpoint = os.environ.get(
                    "SOMA_HUB_URL", changes.get("hub_url", cfg["hub_url"])
                ).rstrip("/")
                try:
                    if sys.stdin.isatty():
                        import getpass

                        token = getpass.getpass("Soma device token: ")
                    else:
                        token = sys.stdin.read().strip()
                except RuntimeError as exc:
                    print(str(exc), file=sys.stderr)
                    return 1
                changes["hub_url"] = endpoint
                changes["keychain"] = True

        def update(prefs):
            prefs.update(changes)
            if "keychain" in changes:
                prefs.pop("token_cmd", None)
                prefs.pop("signed_out", None)
            if "token_cmd" in changes:
                prefs.pop("keychain", None)
                prefs.pop("signed_out", None)

        if token is None:
            update_preferences(data, update)
        else:
            try:
                with credential_lock(data):
                    account = keychain_account(data, endpoint)
                    save_credential(data, account, token, read_token(account), update)
            except RuntimeError as exc:
                print(str(exc), file=sys.stderr)
                return 1
    print(json.dumps(status(data)))
    return 0


def _stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _credential(data: Path, cfg: dict, prefs: dict) -> str:
    # Background auth is independent from the interactive token command.
    if token := os.environ.get("SOMA_HUB_TOKEN"):
        return token
    if prefs.get("signed_out"):
        return ""
    if prefs.get("keychain"):
        from . import DEFAULT_HUB_URL, legacy
        from .credentials import read_token

        account = keychain_account(data, cfg["hub_url"])
        return (
            read_token(account, interactive=False)
            or legacy.adopt_token(data, cfg["hub_url"], DEFAULT_HUB_URL, interactive=False)
            or ""
        )
    cmd = prefs.get("token_cmd", cfg.get("background_token_cmd"))
    if cmd:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=30, check=False
        )
        if result.returncode:
            raise RuntimeError("credential command failed")
        token = result.stdout.strip()
        if "\n" in token or "\r" in token:
            raise RuntimeError("credential command returned an invalid token")
        return token
    return ""


def run(data: Path, poll_seconds: int) -> int:
    """Stay supervised while disabled; never authenticate until opted in."""
    from . import (
        SAFETY_SECONDS,
        RemoteChanges,
        _transient,
        db_changed,
        db_version,
        hub_from_config,
        init,
        load_config,
        pending_local_writes,
        sync,
    )
    from .credentials import KeychainError

    data.mkdir(parents=True, exist_ok=True)
    with (data / "background.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("background sync is already running", file=sys.stderr)
            return 1
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()
        current = read_json(data / "background-status.json")
        current["sync_requests"] = 1
        saved_status = None
        path = data / "soma.db"
        hub = None
        # The hub's change long poll (RemoteChanges) for the current hub only.
        remote = listening = None
        previous_config = None
        fingerprint = db_version(path)
        next_sync = last_round = 0.0
        again = False  # a write landed while the last round ran
        retry = RETRY_FIRST
        while True:
            request_id = None
            try:
                request_id = _sync_request(data)
                if remote is not None and listening is not hub:
                    remote.stop()
                    remote = None
                prefs = read_json(data / "background.json")
                if not prefs.get("enabled", False):
                    hub = None
                    previous_config = None
                    next_sync = 0.0
                    retry = RETRY_FIRST
                    current["state"] = "disabled"
                    if request_id:
                        raise RuntimeError("background sync is disabled")
                else:
                    cfg = load_config(data, resolve_auth=False)
                    signature = (cfg, prefs)
                    changed, fingerprint = db_changed(path, fingerprint)
                    if signature != previous_config:
                        hub = None
                        next_sync = 0.0
                        retry = RETRY_FIRST
                        previous_config = signature
                    idle = current.get("state") == "idle"
                    if idle and remote is not None and remote.live:
                        # Remote edits arrive as signals; the poll is only a safety net.
                        due = time.monotonic() >= last_round + SAFETY_SECONDS
                    else:
                        due = time.monotonic() >= next_sync
                    signalled = remote is not None and remote.take()
                    if request_id or due or ((changed or signalled or again) and hub and idle):
                        again = False
                        current.update(
                            state="authenticating" if hub is None else "syncing",
                            last_attempt=_stamp(),
                            stats=None,
                            last_error=None,
                        )
                        write_json(data / "background-status.json", current)
                        if hub is None:
                            token = _credential(data, cfg, prefs)
                            if not token:
                                raise RuntimeError("no background credential configured")
                            hub = hub_from_config({**cfg, "token": token})
                            if hasattr(hub, "changes"):
                                remote, listening = RemoteChanges(hub, poll_seconds), hub
                                remote.start()
                            current["state"] = "syncing"
                            write_json(data / "background-status.json", current)
                        init(path)
                        stats = sync(path, hub)
                        current["stats"] = {k: v for k, v in stats.items() if k != "rejected"}
                        current["stats"]["rejected"] = len(stats.get("rejected", []))
                        if stats.get("rejected"):
                            # Catalog names and rule ids only: never row ids or messages.
                            kinds = Counter(
                                f"{r.get('table')}{'.' + r['col'] if r.get('col') else ''}:{r.get('rule')}"
                                for r in stats["rejected"]
                            )
                            print(
                                "rejected: "
                                + ", ".join(f"{k} x{n}" for k, n in sorted(kinds.items())),
                                file=sys.stderr,
                                flush=True,
                            )
                            raise RuntimeError("hub rejected rows")
                        current.update(state="idle", last_success=_stamp(), last_error=None)
                        # The fingerprint absorbs this round's own writes, and with
                        # them any made meanwhile: those still need pushing.
                        fingerprint = db_version(path)
                        again = pending_local_writes(path)
                        retry = RETRY_FIRST
                        last_round = time.monotonic()
                        next_sync = last_round + poll_seconds
                        if request_id:
                            write_json(
                                data / "sync-result.json", {"id": request_id, "stats": stats}
                            )
            except Exception as exc:  # noqa: BLE001 - stay alive through outages
                # Exception messages/remote bodies can contain credentials or data.
                http_error = exc if isinstance(exc, urllib.error.HTTPError) else exc.__cause__
                if isinstance(http_error, urllib.error.HTTPError):
                    error = f"HTTP {http_error.code}"
                    if http_error.code in {401, 403}:
                        hub = None
                elif isinstance(exc, KeychainError):
                    error = str(exc)  # Native status only; no credential or remote body.
                elif (
                    isinstance(exc, RuntimeError)
                    and str(exc)
                    in {
                        "no background credential configured",
                        "credential command failed",
                        "credential command returned an invalid token",
                        "hub rejected rows",
                        "background sync is disabled",
                    }
                    or isinstance(exc, ValueError)
                    and str(exc).startswith("hub changed;")
                ):
                    error = str(exc)
                else:
                    error = type(exc).__name__
                if request_id:
                    write_json(
                        data / "sync-result.json",
                        {"id": request_id, "stats": stats}
                        if error == "hub rejected rows"
                        else {"id": request_id, "error": error},
                    )
                current.update(state="retrying", last_error=error)
                # A server failure's own words (bounded) go to the daemon log only;
                # the status file keeps the redacted class above.
                detail = f"{type(exc).__name__}: {str(exc)[:300]}" if _transient(exc) else error
                print(f"sync failed: {detail}", file=sys.stderr, flush=True)
                if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc):
                    next_sync = time.monotonic() + LOCKED_RETRY
                else:
                    next_sync = time.monotonic() + retry
                    retry = min(retry * 2, RETRY_MAX if hub else CREDENTIAL_RETRY_MAX)
            if current != saved_status:
                write_json(data / "background-status.json", current)
                saved_status = current.copy()
            # While idle a hub signal ends the tick at once: remote edits start
            # a round the moment they land. Any other state ignores signals, and
            # an iteration that failed before taking one would never clear it.
            if remote is not None and current.get("state") == "idle":
                remote.wait(1)
            else:
                time.sleep(1)
