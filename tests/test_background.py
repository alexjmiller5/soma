"""Exercise the installed CLI shape and runner against a real HTTP hub."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from test_core import _serve

from soma import execute_sql


def cli(data, *args, **kwargs):
    env = {
        **os.environ,
        "SOMA_DATA_DIR": str(data),
        "PYTHONPATH": os.environ.get("SOMA_TEST_SRC", str(Path("src").resolve())),
    }
    env.pop("SOMA_HUB_TOKEN", None)
    env.pop("SOMA_HUB_URL", None)
    return subprocess.run(
        [sys.executable, "-c", "from soma import main; raise SystemExit(main())", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        **kwargs,
    )


def wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(0.05)
    raise AssertionError("background state did not converge")


def test_background_is_off_and_inspectable_without_credentials(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"token_cmd": "exit 99"}))
    result = cli(tmp_path, "background", "status")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["enabled"] is False
    assert json.loads(result.stdout)["running"] is False
    assert cli(tmp_path, "background", "disable").returncode == 0


def test_cli_toggle_controls_real_runner_and_persists_across_restart(tmp_path):
    data = tmp_path / "client"
    data.mkdir()
    server = _serve(tmp_path / "hub.db")
    cfg = {"hub_url": f"http://127.0.0.1:{server.server_port}", "token_cmd": "exit 99"}
    (data / "config.json").write_text(json.dumps(cfg))
    runner = None
    try:

        def start():
            env = {
                **os.environ,
                "SOMA_DATA_DIR": str(data),
                "PYTHONPATH": os.environ.get("SOMA_TEST_SRC", str(Path("src").resolve())),
            }
            env.pop("SOMA_HUB_TOKEN", None)
            env.pop("SOMA_HUB_URL", None)
            return subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "from soma import main; raise SystemExit(main())",
                    "background",
                    "run",
                    "--poll",
                    "1",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

        assert cli(data, "init").returncode == 0
        runner = start()
        assert cli(data, "table", "create", "items", "name:text").returncode == 0
        assert cli(data, "insert", "items", input='[{"id":"one","name":"First"}]').returncode == 0
        assert (
            cli(data, "background", "enable", "--token-command", "printf testtoken").returncode == 0
        )
        wait_for(lambda: json.loads(cli(data, "background", "status").stdout).get("last_success"))
        assert execute_sql(tmp_path / "hub.db", "SELECT name FROM items")[0]["name"] == "First"
        status = json.loads(cli(data, "background", "status").stdout)
        assert status["enabled"] and status["running"] and status["last_error"] is None
        duplicate = cli(data, "background", "run")
        assert duplicate.returncode == 1 and "already running" in duplicate.stderr
        if sys.platform == "darwin":
            import signal

            runner.send_signal(signal.SIGSTOP)
            try:
                wait_for(
                    lambda: not json.loads(cli(data, "background", "status").stdout)["running"]
                )
            finally:
                runner.send_signal(signal.SIGCONT)
        assert "testtoken" not in cli(data, "background", "status").stdout
        assert cli(data, "background", "disable").returncode == 0
        wait_for(
            lambda: json.loads(cli(data, "background", "status").stdout).get("state") == "disabled"
        )
        runner.terminate()
        runner.communicate(timeout=5)
        runner = start()
        wait_for(lambda: json.loads(cli(data, "background", "status").stdout).get("running"))
        assert cli(data, "insert", "items", input='[{"id":"two","name":"Second"}]').returncode == 0
        time.sleep(1.2)
        assert execute_sql(tmp_path / "hub.db", "SELECT count(*) AS n FROM items")[0]["n"] == 1
        assert json.loads(cli(data, "background", "status").stdout)["enabled"] is False
        assert cli(data, "background", "enable").returncode == 0
        wait_for(
            lambda: execute_sql(tmp_path / "hub.db", "SELECT count(*) AS n FROM items")[0]["n"] == 2
        )
    finally:
        if runner:
            runner.terminate()
            runner.communicate(timeout=5)
        server.shutdown()


def test_disabled_runner_never_reads_credentials_and_errors_back_off(tmp_path, monkeypatch):
    from soma import background

    (tmp_path / "config.json").write_text(json.dumps({"token_cmd": "exit 99"}))
    # Break this by resolving credentials before checking enabled, or by
    # retrying on every tick: the command marker will appear too early/often.
    marker = tmp_path / "reads"
    command = f"printf x >> '{marker}'; printf sensitive-detail >&2; exit 1"
    background.write_json(tmp_path / "background.json", {"enabled": False, "token_cmd": command})
    ticks = []

    def sleep(_):
        ticks.append(1)
        if len(ticks) == 1:
            assert not marker.exists()
            background.write_json(
                tmp_path / "background.json", {"enabled": True, "token_cmd": command}
            )
        elif len(ticks) == 3:
            raise KeyboardInterrupt

    monkeypatch.setattr(background.time, "sleep", sleep)
    import pytest

    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    assert marker.read_text() == "x"
    saved = (tmp_path / "background-status.json").read_text()
    assert "sensitive-detail" not in saved
    assert background.status(tmp_path)["last_error"] == "credential command failed"
    assert background.status(tmp_path)["running"] is False


def test_keychain_enable_stores_no_plaintext_and_status_does_not_unlock(
    tmp_path, monkeypatch, capsys
):
    import io

    from soma import credentials, load_config, main

    saved = {}
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    monkeypatch.delenv("SOMA_HUB_URL", raising=False)
    monkeypatch.setattr(
        credentials, "store_token", lambda account, token: saved.update({account: token})
    )
    monkeypatch.setattr(
        credentials,
        "read_token",
        lambda account, service="soma", **_: saved.get(account) if service == "soma" else None,
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("private-test-value\n"))
    assert main(["background", "enable", "--token-stdin", "--hub-url", "https://hub.example"]) == 0
    assert list(saved.values()) == ["private-test-value"]
    assert "private-test-value" not in (tmp_path / "background.json").read_text()
    monkeypatch.setattr(credentials, "read_token", lambda account, **_: saved[account])
    assert load_config()["token"] == "private-test-value"
    monkeypatch.setattr(
        credentials,
        "read_token",
        lambda _: (_ for _ in ()).throw(AssertionError("unlock attempted")),
    )
    assert main(["background", "disable"]) == 0
    assert main(["background", "status"]) == 0
    assert "private-test-value" not in capsys.readouterr().out


def test_rejected_rows_are_not_a_success_and_do_not_leak(tmp_path, monkeypatch):
    import pytest

    import soma
    from soma import background

    background.write_json(tmp_path / "background.json", {"enabled": True})
    background.write_json(tmp_path / "sync-request.json", {"id": "test-request"})
    monkeypatch.setenv("SOMA_HUB_TOKEN", "test-credential")
    monkeypatch.setattr(soma, "hub_from_config", lambda _: object())
    monkeypatch.setattr(
        soma,
        "sync",
        lambda *_: {
            "pushed": 0,
            "pulled": 0,
            "ddl_applied": 0,
            "rejected": [{"id": "private-row", "error": "private-detail"}],
        },
    )
    monkeypatch.setattr(
        background.time, "sleep", lambda _: (_ for _ in ()).throw(KeyboardInterrupt())
    )
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    report = background.status(tmp_path)
    assert report["last_success"] is None
    assert report["last_error"] == "hub rejected rows"
    assert report["stats"]["rejected"] == 1
    assert "private" not in (tmp_path / "background-status.json").read_text()

    receipt = background.read_json(tmp_path / "sync-result.json")
    assert receipt["id"] == "test-request"
    assert receipt["stats"]["rejected"] == [{"id": "private-row", "error": "private-detail"}]


def test_rejected_rows_are_summarized_in_the_log_without_ids_or_messages(
    tmp_path, monkeypatch, capsys
):
    import pytest

    import soma
    from soma import background

    background.write_json(tmp_path / "background.json", {"enabled": True})
    monkeypatch.setenv("SOMA_HUB_TOKEN", "test-credential")
    monkeypatch.setattr(soma, "hub_from_config", lambda _: object())
    rejected = [
        {
            "table": "songs",
            "id": "private-a",
            "col": None,
            "rule": "write-budget",
            "message": "private-m",
        },
        {
            "table": "songs",
            "id": "private-b",
            "col": None,
            "rule": "write-budget",
            "message": "private-m",
        },
        {"table": "tasks", "id": "private-c", "col": "due", "rule": "type", "message": "private-m"},
    ]
    monkeypatch.setattr(
        soma, "sync", lambda *_: {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": rejected}
    )
    monkeypatch.setattr(
        background.time, "sleep", lambda _: (_ for _ in ()).throw(KeyboardInterrupt())
    )
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    log = capsys.readouterr().err
    assert "rejected: songs:write-budget x2, tasks.due:type x1" in log
    assert "private" not in log


def test_wrapped_unauthorized_reloads_credential_and_redacts_body(tmp_path, monkeypatch, capsys):
    import urllib.error

    import pytest

    import soma
    from soma import background

    background.write_json(tmp_path / "background.json", {"enabled": True})
    calls = []
    monkeypatch.setattr(background, "_credential", lambda *_: calls.append("read") or "test-token")
    monkeypatch.setattr(soma, "hub_from_config", lambda _: object())

    def sync(*_):
        try:
            raise urllib.error.HTTPError("https://hub.example", 401, "unauthorized", {}, None)
        except urllib.error.HTTPError as exc:
            raise RuntimeError("private body") from exc

    monkeypatch.setattr(soma, "sync", sync)
    ticks = []
    monkeypatch.setattr(background.time, "monotonic", lambda: len(ticks) * 61)

    def sleep(_):
        ticks.append(1)
        if len(ticks) == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr(background.time, "sleep", sleep)
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    assert calls == ["read", "read"]
    assert background.status(tmp_path)["last_error"] == "HTTP 401"
    assert "private body" not in (tmp_path / "background-status.json").read_text()
    assert "private body" not in capsys.readouterr().err


def test_server_error_detail_reaches_daemon_log_not_status(tmp_path, monkeypatch, capsys):
    import urllib.error

    import soma
    from soma import background

    background.write_json(tmp_path / "background.json", {"enabled": True})
    monkeypatch.setattr(background, "_credential", lambda *_: "test-token")
    monkeypatch.setattr(soma, "hub_from_config", lambda _: object())

    def sync(*_):
        try:
            raise urllib.error.HTTPError("https://hub.example", 500, "error", {}, None)
        except urllib.error.HTTPError as exc:
            raise RuntimeError('hub HTTP 500: {"error":"D1_ERROR: storage timeout"}') from exc

    monkeypatch.setattr(soma, "sync", sync)
    ticks = []
    monkeypatch.setattr(background.time, "monotonic", lambda: len(ticks) * 61)

    def sleep(_):
        ticks.append(1)
        if len(ticks) == 1:
            raise KeyboardInterrupt

    monkeypatch.setattr(background.time, "sleep", sleep)
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    assert background.status(tmp_path)["last_error"] == "HTTP 500"
    assert "D1_ERROR: storage timeout" in capsys.readouterr().err


def test_keychain_save_uses_same_env_endpoint_as_lookup(tmp_path, monkeypatch):
    import io

    from soma import credentials, load_config, main
    from soma.background import keychain_account

    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", "https://env.example/")
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    monkeypatch.setattr(sys, "stdin", io.StringIO("test-token"))
    saved = {}
    monkeypatch.setattr(
        credentials, "store_token", lambda account, token: saved.update({account: token})
    )
    monkeypatch.setattr(
        credentials,
        "read_token",
        lambda account, service="soma", **_: saved.get(account) if service == "soma" else None,
    )
    assert (
        main(["background", "enable", "--hub-url", "https://config.example", "--token-stdin"]) == 0
    )
    assert saved == {keychain_account(tmp_path, "https://env.example"): "test-token"}
    assert load_config()["token"] == "test-token"


def test_changing_hubs_requires_a_fresh_data_directory(tmp_path):
    import pytest

    from soma import HttpHub, create_table, init, insert_rows, sync

    path = init(tmp_path / "client.db")
    create_table(path, "items", ["name:text"])
    insert_rows(path, "items", [{"id": "one", "name": "First"}])
    first = _serve(tmp_path / "first.db")
    second = None
    try:
        sync(
            path,
            HttpHub(f"http://127.0.0.1:{first.server_port}", {"Authorization": "Bearer testtoken"}),
        )
        second = _serve(tmp_path / "second.db")
        with pytest.raises(ValueError, match="fresh data directory"):
            sync(
                path,
                HttpHub(
                    f"http://127.0.0.1:{second.server_port}", {"Authorization": "Bearer testtoken"}
                ),
            )
        assert (
            execute_sql(tmp_path / "second.db", "SELECT name FROM sqlite_master WHERE name='items'")
            == []
        )
    finally:
        first.shutdown()
        if second:
            second.shutdown()


def test_legacy_cursor_cannot_be_repointed_by_enable(tmp_path, monkeypatch):
    from soma import _set_state, init, main
    from soma.background import read_json

    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_URL", raising=False)
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    (tmp_path / "config.json").write_text(json.dumps({"hub_url": "https://first.example"}))
    path = init(tmp_path / "soma.db")
    _set_state(path, "last_push", "2026-01-01T00:00:00.000Z")
    assert main(["background", "enable", "--hub-url", "https://second.example"]) == 1
    assert read_json(tmp_path / "background.json") == {}


def test_legacy_http_cursors_are_not_trusted_without_an_endpoint(tmp_path):
    from soma import HttpHub, _set_state, create_table, init, insert_rows, sync

    path = init(tmp_path / "client.db")
    create_table(path, "items", ["name:text"])
    insert_rows(path, "items", [{"id": "one", "name": "First"}])
    # A replica made by the old client has cursors but no recorded endpoint.
    _set_state(path, "last_push", "2099-01-01T00:00:00.000Z")
    _set_state(path, "last_pull", "2099-01-01T00:00:00.000Z")
    server = _serve(tmp_path / "hub.db")
    try:
        result = sync(
            path,
            HttpHub(
                f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer testtoken"}
            ),
        )
        assert result["rejected"] == []
        assert execute_sql(tmp_path / "hub.db", "SELECT name FROM items") == [{"name": "First"}]
    finally:
        server.shutdown()


def test_background_auth_respects_native_selection_signout_and_explicit_env(tmp_path, monkeypatch):
    from soma import background, credentials

    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    cfg = {"hub_url": "https://hub.example", "background_token_cmd": "exit 99", "token": "old"}
    token = "native-token"

    def read(account, *, interactive=True, service="soma"):
        assert interactive is False
        return token

    monkeypatch.setattr(credentials, "read_token", read)
    assert background._credential(tmp_path, cfg, {"keychain": True}) == "native-token"
    token = None
    assert background._credential(tmp_path, cfg, {"keychain": True}) == ""
    monkeypatch.setattr(
        credentials, "read_token", lambda *_a, **_kw: pytest.fail("signed-out native read")
    )
    for prefs in ({"signed_out": True}, {"signed_out": True, "keychain": True}):
        assert background._credential(tmp_path, cfg, prefs) == ""
    monkeypatch.setenv("SOMA_HUB_TOKEN", "operator-override")
    assert background._credential(tmp_path, cfg, prefs) == "operator-override"


def test_native_failure_reports_auth_phase_code_and_then_observes_disable(tmp_path, monkeypatch):
    import soma
    from soma import background, credentials

    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    monkeypatch.delenv("SOMA_HUB_URL", raising=False)
    background.write_json(tmp_path / "background.json", {"enabled": True, "keychain": True})
    success = "2026-01-01T00:00:00.000Z"
    background.write_json(
        tmp_path / "background-status.json",
        {
            "state": "idle",
            "last_success": success,
            "last_error": "old-error",
            "stats": {"pushed": 2, "pulled": 3, "rejected": 0},
        },
    )
    reads = []

    def read(account, *, interactive=True, service="soma"):
        reads.append(interactive)
        current = background.read_json(tmp_path / "background-status.json")
        assert current["state"] == "authenticating"
        assert current["stats"] is None and current["last_error"] is None
        assert current["last_success"] == success
        credentials._check(-25293)

    monkeypatch.setattr(credentials, "read_token", read)
    monkeypatch.setattr(soma, "sync", lambda *_: pytest.fail("sync before authentication"))
    ticks = []

    def sleep(_):
        ticks.append(background.read_json(tmp_path / "background-status.json"))
        if len(ticks) == 1:
            assert ticks[-1]["state"] == "retrying"
            assert ticks[-1]["last_error"] == "Keychain operation failed (OS status -25293)."
            background.update_preferences(tmp_path, lambda p: p.update(enabled=False))
        else:
            raise KeyboardInterrupt

    monkeypatch.setattr(background.time, "sleep", sleep)
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    assert reads == [False]
    assert ticks[-1]["state"] == "disabled"
    assert ticks[-1]["last_success"] == success
    assert ticks[-1]["stats"] is None
    assert not (tmp_path / "soma.db").exists()


def test_authentication_transitions_to_sync_and_preserves_success_until_completion(
    tmp_path, monkeypatch
):
    import soma
    from soma import background

    monkeypatch.setenv("SOMA_HUB_TOKEN", "synthetic")
    background.write_json(tmp_path / "background.json", {"enabled": True})
    monkeypatch.setattr(soma, "hub_from_config", lambda _: object())

    def sync(*_):
        current = background.read_json(tmp_path / "background-status.json")
        assert current["state"] == "syncing" and current["stats"] is None
        assert current.get("last_success") is None
        return {"pushed": 1, "pulled": 0, "ddl_applied": 0, "rejected": []}

    monkeypatch.setattr(soma, "sync", sync)
    monkeypatch.setattr(
        background.time, "sleep", lambda _: (_ for _ in ()).throw(KeyboardInterrupt)
    )
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    current = background.read_json(tmp_path / "background-status.json")
    assert current["state"] == "idle" and current["last_success"]
    assert current["stats"]["pushed"] == 1


def test_preference_updates_serialize_with_another_process_and_return_merged_state(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from soma import background

    update = background.update_preferences
    background.write_json(tmp_path / "background.json", {"enabled": True, "revision": 1})
    entered, release = Event(), Event()

    def auth(prefs):
        entered.set()
        assert release.wait(5)
        prefs["keychain"] = True

    code = """from pathlib import Path
import json, sys
from soma.background import update_preferences
print('ready', flush=True)
print(json.dumps(update_preferences(Path(sys.argv[1]), lambda p: p.update(enabled=False))), flush=True)
"""
    process = None
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(update, tmp_path, auth)
        try:
            assert entered.wait(5)
            process = subprocess.Popen(
                [sys.executable, "-B", "-c", code, str(tmp_path)],
                env={**os.environ, "PYTHONPATH": str(Path("src").resolve())},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            assert process.stdout.readline().strip() == "ready"
            with pytest.raises(subprocess.TimeoutExpired):
                process.wait(timeout=0.15)
        finally:
            release.set()
            if process:
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    raise
        assert pending.result() == {"enabled": True, "keychain": True, "revision": 2}
    assert process.returncode == 0, stderr
    expected = {"enabled": False, "keychain": True, "revision": 3}
    assert json.loads(stdout) == expected
    assert background.read_json(tmp_path / "background.json") == expected
    with pytest.raises(ValueError):
        update(tmp_path, lambda p: (_ for _ in ()).throw(ValueError("aborted")))
    assert background.read_json(tmp_path / "background.json") == expected
    assert update(tmp_path, lambda p: p.update(enabled=True))["revision"] == 4


def test_enable_merges_after_keychain_work_without_holding_preference_lock(tmp_path, monkeypatch):
    import fcntl
    import io

    from soma import background, credentials, main

    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    monkeypatch.delenv("SOMA_HUB_URL", raising=False)
    background.write_json(
        tmp_path / "background.json",
        {
            "enabled": False,
            "revision": 1,
            "signed_out": True,
        },
    )

    def store(account, token):
        with (tmp_path / "preferences.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        background.update_preferences(tmp_path, lambda p: p.update(other_preference="preserved"))

    monkeypatch.setattr(credentials, "store_token", store)
    monkeypatch.setattr(credentials, "read_token", lambda *_, **__: None)
    monkeypatch.setattr(sys, "stdin", io.StringIO("synthetic-token"))
    assert main(["background", "enable", "--token-stdin"]) == 0
    prefs = background.read_json(tmp_path / "background.json")
    assert prefs["enabled"] and prefs["keychain"] and prefs["revision"] == 3
    assert not prefs.get("signed_out") and prefs["other_preference"] == "preserved"
    background.update_preferences(tmp_path, lambda p: p.update(signed_out=True))
    assert main(["background", "disable"]) == 0
    assert main(["background", "enable"]) == 0
    assert background.read_json(tmp_path / "background.json")["signed_out"] is True


@pytest.fixture
def native_lifecycle(tmp_path, monkeypatch):
    import ctypes
    import io
    from types import SimpleNamespace

    from soma import background, credentials, login

    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    monkeypatch.delenv("SOMA_HUB_URL", raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sys, "stdin", io.StringIO("fixture-compatibility"))
    monkeypatch.setattr(ctypes, "CDLL", lambda *_: pytest.fail("native access forbidden"))
    endpoint = "https://hub.example"
    account = background.keychain_account(tmp_path, endpoint)
    tokens = {account: "fixture-existing"}
    monkeypatch.setattr(
        credentials,
        "read_token",
        lambda account, service="soma", **_: tokens.get(account) if service == "soma" else None,
    )
    monkeypatch.setattr(credentials, "store_token", lambda key, value: tokens.update({key: value}))
    monkeypatch.setattr(credentials, "delete_token", lambda key: tokens.pop(key, None))
    monkeypatch.setattr(
        login,
        "_request_json",
        lambda _endpoint, _route, method, _token, **_kwargs: (
            200,
            {"logged_out": True}
            if method == "POST"
            else {"name": "device:fixture", "scopes": ["full"]},
        ),
    )
    background.write_json(
        tmp_path / "background.json",
        {
            "hub_url": endpoint,
            "keychain": True,
            "enabled": False,
            "revision": 2,
            "other_preference": "preserved",
        },
    )
    return SimpleNamespace(tokens=tokens, account=account, endpoint=endpoint)


def test_stdin_lock_contention_preserves_native_credential_and_preferences(
    tmp_path, capsys, native_lifecycle
):
    import fcntl
    import io
    from unittest.mock import patch

    from soma import background, main

    prefs_path = tmp_path / "background.json"
    before = prefs_path.read_bytes()
    with (tmp_path / "credentials.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert main(["background", "enable", "--token-stdin"]) == 1
        assert native_lifecycle.tokens[native_lifecycle.account] == "fixture-existing"
        assert prefs_path.read_bytes() == before
    assert "credential update" in capsys.readouterr().err
    # The same supported command succeeds on retry once the lifecycle lock is free.
    with patch.object(sys, "stdin", io.StringIO("fixture-compatibility")):
        assert main(["background", "enable", "--token-stdin"]) == 0
    assert native_lifecycle.tokens[native_lifecycle.account] == "fixture-compatibility"
    prefs = background.read_json(prefs_path)
    assert prefs["keychain"] and prefs["enabled"] and prefs["revision"] == 3


@pytest.mark.parametrize("operation", ["login", "logout"])
@pytest.mark.parametrize("pause_at", ["native_write", "preferences"])
def test_stdin_install_excludes_login_logout_through_preference_commit(
    tmp_path, monkeypatch, native_lifecycle, operation, pause_at
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from soma import background, credentials, login, main

    entered, release = Event(), Event()
    module, method = (
        (credentials, "store_token")
        if pause_at == "native_write"
        else (background, "update_preferences")
    )
    original = getattr(module, method)

    def paused(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(module, method, paused)
    with ThreadPoolExecutor(max_workers=1) as pool:
        installing = pool.submit(main, ["background", "enable", "--token-stdin"])
        try:
            assert entered.wait(5)
            before_tokens = dict(native_lifecycle.tokens)
            before_prefs = (tmp_path / "background.json").read_bytes()
            with pytest.raises(RuntimeError, match="credential update"):
                if operation == "login":
                    login.login(tmp_path, no_browser=True, name="Review device")
                else:
                    login.logout(tmp_path)
            assert native_lifecycle.tokens == before_tokens
            assert (tmp_path / "background.json").read_bytes() == before_prefs
        finally:
            release.set()
        assert installing.result(timeout=5) == 0
    assert native_lifecycle.tokens[native_lifecycle.account] == "fixture-compatibility"
    prefs = background.read_json(tmp_path / "background.json")
    assert prefs["keychain"] and prefs["enabled"] and prefs["revision"] == 3
    assert prefs["other_preference"] == "preserved"


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("rollback_fails", [False, True])
def test_stdin_preference_failure_restores_native_item_or_reports_rollback_failure(
    tmp_path, monkeypatch, capsys, native_lifecycle, existing, rollback_fails
):
    import fcntl

    from soma import credentials, main

    if not existing:
        native_lifecycle.tokens.clear()
    before_tokens = dict(native_lifecycle.tokens)
    before_prefs = (tmp_path / "background.json").read_bytes()
    restore_name = "store_token" if existing else "delete_token"
    original = getattr(credentials, restore_name)

    def restore(*args):
        if not existing or args[1] == "fixture-existing":
            with (
                (tmp_path / "credentials.lock").open("a+") as lock,
                pytest.raises(BlockingIOError),
            ):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if rollback_fails:
                raise RuntimeError("fixture-private-rollback-diagnostic")
        return original(*args)

    def fail_replace(*_):
        raise OSError("fixture-private-persistence-diagnostic")

    monkeypatch.setattr(credentials, restore_name, restore)
    monkeypatch.setattr(os, "replace", fail_replace)
    assert main(["background", "enable", "--token-stdin"]) == 1
    assert (tmp_path / "background.json").read_bytes() == before_prefs
    output = capsys.readouterr()
    assert "fixture-" not in output.out + output.err
    if rollback_fails:
        assert "rollback failed" in output.err
    else:
        assert native_lifecycle.tokens == before_tokens
        assert "install" in output.err


@pytest.fixture
def delegated_runner(tmp_path):
    """A real daemon has a credential that the CLI's environment cannot read."""
    data = tmp_path / "client"
    data.mkdir()
    server = _serve(tmp_path / "hub.db")
    (data / "config.json").write_text(
        json.dumps(
            {
                "hub_url": f"http://127.0.0.1:{server.server_port}",
                "token_cmd": "exit 99",
            }
        )
    )
    assert cli(data, "init").returncode == 0
    assert cli(data, "background", "enable", "--token-command", "printf testtoken").returncode == 0
    env = {
        **os.environ,
        "SOMA_DATA_DIR": str(data),
        "PYTHONPATH": os.environ.get("SOMA_TEST_SRC", str(Path("src").resolve())),
    }
    env.pop("SOMA_HUB_TOKEN", None)
    env.pop("SOMA_HUB_URL", None)
    runner = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from soma import main; raise SystemExit(main())",
            "background",
            "run",
            "--poll",
            "3600",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        wait_for(lambda: json.loads(cli(data, "background", "status").stdout).get("last_success"))
        yield data, server, runner
    finally:
        runner.terminate()
        runner.communicate(timeout=5)
        server.shutdown()


def test_sync_cli_uses_daemon_without_reading_interactive_credentials(delegated_runner):
    # Removing delegation makes this hit the intentionally broken token command.
    data, _, _ = delegated_runner
    before = json.loads(cli(data, "background", "status").stdout)["last_success"]
    result = cli(data, "sync")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["rejected"] == []
    assert json.loads(cli(data, "background", "status").stdout)["last_success"] > before
    assert "testtoken" not in result.stdout + result.stderr
    assert not (data / "sync-request.json").exists()


def test_daemon_sync_failure_is_returned_without_credentials(delegated_runner):
    # A daemon failure must not turn into stale success or a CLI credential fallback.
    data, _, _ = delegated_runner
    prefs_path = data / "background.json"
    prefs = json.loads(prefs_path.read_text())
    prefs["token_cmd"] = "printf private-invalid-token"
    from soma.background import write_json

    write_json(prefs_path, prefs)
    result = cli(data, "sync")
    assert result.returncode == 1
    assert "HTTP 403" in result.stderr
    assert "private-invalid-token" not in result.stdout + result.stderr


def test_sync_request_times_out_and_removes_request(delegated_runner, monkeypatch):
    # An unresponsive daemon must not hang a foreground caller indefinitely.
    import signal

    from soma import background

    data, _, runner = delegated_runner
    write = background.write_json

    def pause_after_request(path, value):
        runner.send_signal(signal.SIGSTOP)
        write(path, value)

    monkeypatch.setattr(background, "write_json", pause_after_request)
    try:
        with pytest.raises(ValueError, match="timed out"):
            background.request_sync(data, timeout=0.2)
        assert not (data / "sync-request.json").exists()
    finally:
        runner.send_signal(signal.SIGCONT)


def test_concurrent_sync_callers_each_get_a_fresh_result(delegated_runner):
    # Without the client lock one caller can consume another caller's receipt.
    from concurrent.futures import ThreadPoolExecutor

    data, _, _ = delegated_runner
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: cli(data, "sync"), range(2)))
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    assert all(json.loads(r.stdout)["rejected"] == [] for r in results)


def test_explicit_credentials_do_not_use_another_daemon_session(delegated_runner, monkeypatch):
    from soma.background import request_sync

    data, _, _ = delegated_runner
    monkeypatch.setenv("SOMA_HUB_TOKEN", "explicit-token")
    assert request_sync(data) is None
    monkeypatch.delenv("SOMA_HUB_TOKEN")
    monkeypatch.setenv("SOMA_HUB_URL", "https://different.example")
    assert request_sync(data) is None


def test_old_daemon_requires_restart_instead_of_hanging(delegated_runner):

    from soma import background

    data, _, _ = delegated_runner
    # Leave the lock held but stop publishing the protocol marker, as an old runner does.
    path = data / "background-status.json"
    state = json.loads(path.read_text())
    state.pop("sync_requests")
    background.write_json(path, state)
    with pytest.raises(ValueError, match="restart"):
        background.request_sync(data, timeout=0.2)
    assert not (data / "sync-request.json").exists()


def test_sync_cli_rejected_rows_exit_nonzero(tmp_path, monkeypatch, capsys):
    import soma

    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_TOKEN", "test-credential")
    monkeypatch.setattr(soma, "hub_from_config", lambda: object())
    monkeypatch.setattr(
        soma,
        "sync",
        lambda *_: {
            "pushed": 0,
            "pulled": 0,
            "ddl_applied": 0,
            "rejected": [{"id": "row", "rule": "type"}],
        },
    )
    assert soma.main(["sync"]) == 1
    assert json.loads(capsys.readouterr().err)["rejected"] == [{"id": "row", "rule": "type"}]
