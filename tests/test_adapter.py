"""langchain adapter checks: client + LangChain tools against the real API.

    python3 tests/test_adapter.py

Boots the real API as a child process (MOCK_RVN=true, port 3124) and asserts:
  - the stdlib client covers every route (issue / reissue / sub-asset /
    unique / transfer / list / get / simulate / approve / deny / pending /
    policy / presets / audit / wallet)
  - the LangChain tools built on it invoke cleanly: ALLOW, DENY with reason
    codes, hold -> approve -> executed, hold -> deny, 404/409 error shapes
  - simulate has zero side effects (audit entry count unchanged)
  - the audit chain stays valid throughout

Requires langchain-core importable (pip install langchain-core). Nothing
touches the network: the API is localhost-only.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

try:
    import langchain_core  # noqa: F401
except ImportError:
    print("FAIL  langchain-core is required: pip install langchain-core")
    sys.exit(1)

from langchain_rvn import RvnApiClient, RvnApiError, get_tools  # noqa: E402

API_PORT = 3124
API = f"http://127.0.0.1:{API_PORT}"
AUTH_PORT = 3125
AUTH_API = f"http://127.0.0.1:{AUTH_PORT}"
OPERATOR_KEY = "rvn_operator-testkey-0123456789abcdef"
AGENT = "lc-agent"
DEST = "RTestDestinationAddress11111111111111"

failures = 0


def check(name, cond, detail=None):
    global failures
    print(f"{'PASS' if cond else 'FAIL'}  {name}")
    if not cond:
        failures += 1
        if detail is not None:
            print("      ", detail)


def boot_api(port=API_PORT, extra_env=None):
    """Boot the API on `port`; extra_env adds env vars (e.g. auth on)."""
    api = f"http://127.0.0.1:{port}"
    child = subprocess.Popen(
        [os.path.join(REPO, "node_modules", ".bin", "tsx"),
         os.path.join(REPO, "src", "server.ts")],
        env={**os.environ, "PORT": str(port), "MOCK_RVN": "true",
             **(extra_env or {})},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        # tsx spawns a node child: kill the whole group, or the API survives
        # the test and its mock state leaks into the next run.
        start_new_session=True,
    )
    for _ in range(120):
        try:
            with urllib.request.urlopen(f"{api}/v1/health", timeout=2) as resp:
                if resp.status == 200:
                    return child
        except Exception:
            pass
        time.sleep(0.25)
    kill_api(child)
    raise RuntimeError("API did not come up in time")


def kill_api(child):
    import signal
    try:
        os.killpg(os.getpgid(child.pid), signal.SIGTERM)
    except Exception:
        child.kill()


def _raw(method, url, body=None, key=None):
    """Minimal raw request (no client): used for the admin surface, which
    the client deliberately does not wrap."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"content-type": "application/json"})
    if key is not None:
        req.add_header("authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


def issue_agent_key(api, agent):
    """Issue a per-agent key through the admin surface (operator key)."""
    status, payload = _raw("POST", f"{api}/v1/admin/api-keys",
                           {"agentId": agent}, key=OPERATOR_KEY)
    assert status == 200, (status, payload)
    return payload["key"]


def main():
    child = boot_api()
    try:
        client = RvnApiClient(API, agent_id=AGENT)

        health = client.health()
        check("health ok, mock node", health.get("ok") is True and health.get("mock") is True, health)

        applied = client.apply_preset("permissive")
        check("apply permissive preset",
              applied.get("preset") == "permissive"
              and applied["policy"]["allowedDestinations"] == ["*"], applied)
        check("policy reads back wildcard",
              client.get_policy()["allowedDestinations"] == ["*"])

        # Per-address asset balances (v0.42.0): the agent can only
        # transfer assets its own wallet address holds, so the coin is
        # issued to the agent's wallet address, then 10 move onward to
        # DEST — the agent-scoped balances below read 90, not 100.
        own_address = client.get_wallet_address()["address"]
        issued = client.issue_asset("LCADAPTER", "100", own_address)
        check("client issue ALLOW with txid",
              issued["decision"]["kind"] == "ALLOW" and bool(issued.get("txid")), issued)

        assets = client.list_assets("LC*")["assets"]
        names = [a["name"] for a in assets]
        check("list_assets finds LCADAPTER", "LCADAPTER" in names, names)
        info = client.get_asset("LCADAPTER")
        check("get_asset returns the issued asset", info.get("name") == "LCADAPTER", info)

        moved = client.transfer_asset("LCADAPTER", "10", DEST)
        check("client transfer ALLOW", moved["decision"]["kind"] == "ALLOW", moved)

        before = client.get_audit()["entries"]
        sim = client.simulate_intent("issue", "LCADAPTER", "20000000", DEST)
        after = client.get_audit()["entries"]
        check("client simulate over-cap DENY",
              sim["decision"]["kind"] == "DENY"
              and "ISSUE_CAP_EXCEEDED" in sim["decision"]["reasonCodes"], sim)
        check("simulate has zero audit side effects", len(before) == len(after),
              (len(before), len(after)))

        # --- LangChain tools ---
        tools = get_tools(client)
        by_name = {t.name: t for t in tools}
        check("27 tools built", len(tools) == 27, sorted(by_name))
        check("tool names cover every route",
              {"issue_asset", "reissue_asset", "issue_subasset", "issue_unique",
               "transfer_asset", "list_assets", "get_asset", "simulate_intent",
               "approve_intent", "deny_intent", "pending_intents", "get_policy",
               "set_policy", "list_presets", "apply_preset", "get_policy_history",
               "rollback_policy", "get_ratelimit",
               "get_anomaly_stats", "get_metrics", "get_wallet_balances",
               "get_wallet_address",
               "get_openapi", "get_docs", "get_audit",
               "archive_audit", "create_wallet"} == set(by_name))
        stats = client.get_ratelimit()
        check("client get_ratelimit: unlimited agent reports limited:false",
              stats.get("limited") is False and stats.get("agentId") == AGENT, stats)
        tool_stats = json.loads(by_name["get_ratelimit"].invoke({}))
        check("tool get_ratelimit reports limited:false",
              tool_stats.get("limited") is False, tool_stats)
        anom = client.get_anomaly_stats()
        check("client get_anomaly_stats: fresh agent reports zero holds, default thresholds",
              anom.get("anomalyHolds") == 0
              and anom.get("thresholds", {}).get("qtyMultiple") == 10
              and anom.get("agentId") == AGENT, anom)
        tool_anom = json.loads(by_name["get_anomaly_stats"].invoke({}))
        check("tool get_anomaly_stats reports zero holds",
              tool_anom.get("anomalyHolds") == 0
              and tool_anom.get("bySignal") == {"QTY_OUTLIER": 0,
                                                 "FIRST_SEEN_DESTINATION_BURST": 0},
              tool_anom)
        # Policy history + rollback (v0.35.0): the permissive preset apply
        # above is the agent's first own policy, so the next set archives it.
        base = client.get_policy()
        hist0 = client.get_policy_history()
        check("client get_policy_history: empty before any replacement",
              hist0.get("versions") == [] and hist0.get("agentId") == AGENT, hist0)
        client.set_policy({**base, "maxIssueQtyBaseUnits": "777"})
        hist = client.get_policy_history()
        check("client get_policy_history: one superseded version, source put",
              len(hist.get("versions", [])) == 1
              and hist["versions"][0]["policy"]["maxIssueQtyBaseUnits"] == "10000000"
              and hist["versions"][0]["replacedBy"] == "put", hist)
        vid = hist["versions"][0]["versionId"]
        tool_hist = json.loads(by_name["get_policy_history"].invoke({}))
        check("tool get_policy_history matches the client shape",
              len(tool_hist.get("versions", [])) == 1
              and tool_hist["versions"][0]["versionId"] == vid, tool_hist)
        rolled = client.rollback_policy(vid)
        check("client rollback_policy restores the version",
              rolled.get("policy", {}).get("maxIssueQtyBaseUnits") == "10000000"
              and rolled.get("restoredFrom") == vid, rolled)
        check("policy reads back the restored one",
              client.get_policy()["maxIssueQtyBaseUnits"] == "10000000")
        tool_rb = json.loads(by_name["rollback_policy"].invoke({"version_id": vid}))
        check("tool rollback_policy restores the same version again",
              tool_rb.get("policy", {}).get("maxIssueQtyBaseUnits") == "10000000", tool_rb)
        metrics = client.get_metrics()
        check("client get_metrics: decisions counted, memory store, chain valid",
              metrics.get("store") == "memory"
              and metrics.get("audit", {}).get("chainValid") is True
              and metrics.get("decisions", {}).get("total", 0) >= 1
              and metrics.get("decisions", {}).get("byKind", {}).get("ALLOW", 0) >= 1,
              metrics)
        tool_metrics = json.loads(by_name["get_metrics"].invoke({}))
        check("tool get_metrics matches the client shape",
              tool_metrics.get("decisions", {}).get("total") ==
              metrics.get("decisions", {}).get("total")
              and tool_metrics.get("store") == "memory", tool_metrics)
        balances = client.get_wallet_balances(AGENT)
        check("client get_wallet_balances: agent RVN below the 1,000,000 start, issued coins listed",
              balances.get("rvnBaseUnits", "").isdigit()
              and int(balances["rvnBaseUnits"]) < 1_000_000 * 10**8
              and any(a.get("name") == "LCADAPTER"
                      and a.get("balanceBaseUnits") == "90"
                      for a in balances.get("assets", [])),
              balances)
        tool_balances = json.loads(by_name["get_wallet_balances"].invoke({"agent_id": AGENT}))
        check("tool get_wallet_balances matches the client shape",
              tool_balances.get("rvnBaseUnits") == balances.get("rvnBaseUnits")
              and tool_balances.get("assets") == balances.get("assets"),
              tool_balances)
        address = client.get_wallet_address()
        check("client get_wallet_address: stable address for the calling agent",
              address.get("agentId") == AGENT
              and isinstance(address.get("address"), str)
              and len(address["address"]) > 0,
              address)
        tool_address = json.loads(by_name["get_wallet_address"].invoke({}))
        check("tool get_wallet_address matches the client shape",
              tool_address.get("address") == address.get("address")
              and tool_address.get("agentId") == AGENT,
              tool_address)
        spec = client.get_openapi()
        check("client get_openapi: OpenAPI 3.0.3 contract with every route",
              spec.get("openapi") == "3.0.3"
              and "/v1/assets/issue" in spec.get("paths", {})
              and "/v1/openapi.json" in spec.get("paths", {})
              and "Decision" in spec.get("components", {}).get("schemas", {}),
              sorted(spec.get("paths", {}).keys()))
        tool_spec = json.loads(by_name["get_openapi"].invoke({}))
        check("tool get_openapi matches the client shape",
              tool_spec.get("openapi") == "3.0.3"
              and tool_spec.get("info", {}).get("version") == spec.get("info", {}).get("version"),
              tool_spec.get("info"))
        docs = client.get_docs()
        check("client get_docs: HTML docs page at the package version",
              docs.startswith("<!DOCTYPE html>")
              and f"rvn-agent-api {spec.get('info', {}).get('version')} — API docs" in docs
              and "/v1/assets/issue" in docs
              and "/v1/docs" in docs
              and "<h2>Decision model</h2>" in docs,
              docs[:200])
        tool_docs = by_name["get_docs"].invoke({})
        check("tool get_docs returns the same docs page",
              tool_docs.startswith("<!DOCTYPE html>")
              and "/v1/openapi.json" in tool_docs,
              tool_docs[:200])

        tool_issue = json.loads(by_name["issue_asset"].invoke(
            {"name": "TOOLCOIN", "qty": "50", "to_address": DEST}))
        check("tool issue ALLOW", tool_issue["decision"]["kind"] == "ALLOW", tool_issue)

        tool_sim = json.loads(by_name["simulate_intent"].invoke(
            {"op": "issue", "asset_name": "TOOLCOIN", "qty": "20000000",
             "destination": DEST}))
        check("tool simulate DENY", tool_sim["decision"]["kind"] == "DENY", tool_sim)

        hold = json.loads(by_name["issue_asset"].invoke(
            {"name": "HOLDCOIN", "qty": "2000000", "to_address": DEST}))
        check("tool issue above threshold held",
              hold["decision"]["kind"] == "REQUIRE_APPROVAL", hold)
        hold_id = hold["intent"]["id"]
        pending = json.loads(by_name["pending_intents"].invoke({}))["pending"]
        check("pending lists the held intent",
              any(p["intent"]["id"] == hold_id for p in pending),
              [p["intent"]["id"] for p in pending])

        approved = json.loads(by_name["approve_intent"].invoke(
            {"intent_id": hold_id}))
        check("tool approve executes held intent", bool(approved.get("txid")), approved)
        pending = json.loads(by_name["pending_intents"].invoke({}))["pending"]
        check("approved intent leaves pending",
              all(p["intent"]["id"] != hold_id for p in pending))
        again = json.loads(by_name["approve_intent"].invoke({"intent_id": hold_id}))
        check("re-approve is a 409 error", again.get("status") == 409, again)

        hold2 = json.loads(by_name["issue_asset"].invoke(
            {"name": "DENYCOIN", "qty": "2000000", "to_address": DEST}))
        denied = json.loads(by_name["deny_intent"].invoke(
            {"intent_id": hold2["intent"]["id"]}))
        check("tool deny marks intent denied", denied.get("denied") is True, denied)

        unknown = json.loads(by_name["approve_intent"].invoke(
            {"intent_id": "no-such-intent"}))
        check("approve unknown intent is a 404 error", unknown.get("status") == 404, unknown)

        presets = json.loads(by_name["list_presets"].invoke({}))["presets"]
        check("tool list_presets returns 3 presets", len(presets) == 3,
              [p.get("id") for p in presets])

        policy = json.loads(by_name["get_policy"].invoke({}))
        policy["decisionTtlSeconds"] = 120
        updated = json.loads(by_name["set_policy"].invoke(
            {"policy_json": json.dumps(policy)}))
        check("tool set_policy round-trips",
              updated["policy"]["decisionTtlSeconds"] == 120, updated)

        wallet = json.loads(by_name["create_wallet"].invoke({}))
        check("tool create_wallet returns an address", bool(wallet.get("address")), wallet)

        # --- remaining kinds through the client ---
        reissued = client.reissue_asset("LCADAPTER", "50", DEST)
        check("client reissue ALLOW", reissued["decision"]["kind"] == "ALLOW", reissued)
        sub = client.issue_subasset("LCADAPTER/SUB", "25", DEST)
        check("client sub-asset ALLOW", sub["decision"]["kind"] == "ALLOW", sub)
        unique = client.issue_unique("LCADAPTER#TAG001", DEST)
        check("client unique ALLOW", unique["decision"]["kind"] == "ALLOW", unique)

        audit = json.loads(by_name["get_audit"].invoke({}))
        check("audit chain valid at end", audit.get("chainValid") is True, audit)

        # archive_audit: an ancient cutoff archives nothing and writes no
        # file; the client + tool shapes are exercised without pruning.
        arch_none = client.archive_audit(before_ms=1)
        check("client archive_audit with an ancient cutoff archives nothing",
              arch_none.get("archived") is False and arch_none.get("entries") == 0,
              arch_none)
        tool_arch_none = json.loads(by_name["archive_audit"].invoke({"before_ms": 1}))
        check("tool archive_audit with an ancient cutoff archives nothing",
              tool_arch_none.get("archived") is False
              and tool_arch_none.get("entries") == 0, tool_arch_none)
        # --- API-key auth passthrough (v0.30.0) ---
        # A second, auth-on API: the client must send its key as a Bearer
        # token, or every gated route raises RvnApiError(401).
        auth_child = boot_api(AUTH_PORT, {"RVN_AUTH_ENABLED": "true",
                                          "RVN_OPERATOR_API_KEY": OPERATOR_KEY})
        try:
            no_key = RvnApiClient(AUTH_API, agent_id=AGENT)
            check("auth-on health stays open without a key",
                  no_key.health().get("ok") is True)
            try:
                no_key.list_assets()
                check("keyless client list_assets raises 401", False)
            except RvnApiError as err:
                check("keyless client list_assets raises 401", err.status == 401, err)
            try:
                RvnApiClient(AUTH_API, agent_id=AGENT,
                             api_key="rvn_00000000000000000000000000000000").list_assets()
                check("wrong-key client raises 401", False)
            except RvnApiError as err:
                check("wrong-key client raises 401", err.status == 401, err)

            agent_key = issue_agent_key(AUTH_API, AGENT)
            keyed = RvnApiClient(AUTH_API, agent_id=AGENT, api_key=agent_key)
            keyed.apply_preset("permissive")
            issued_auth = keyed.issue_asset("AUTHCOIN", "100", DEST)
            check("keyed client issue ALLOWs on the auth-on API",
                  issued_auth["decision"]["kind"] == "ALLOW", issued_auth)
            mismatch = keyed.issue_asset("AUTHCOIN", "100", DEST,
                                         agent_id="other-agent")
            check("keyed client acting as another agent gets a 403 payload",
                  "error" in mismatch and "decision" not in mismatch, mismatch)

            # The RVN_API_KEY env var is the fallback when no api_key arg
            # is passed; an explicit argument wins over the env var.
            os.environ["RVN_API_KEY"] = agent_key
            try:
                env_client = RvnApiClient(AUTH_API, agent_id=AGENT)
                env_issue = env_client.issue_asset("AUTHENV", "10", DEST)
                check("client picks up RVN_API_KEY from the environment",
                      env_issue["decision"]["kind"] == "ALLOW", env_issue)
                override = RvnApiClient(
                    AUTH_API, agent_id=AGENT,
                    api_key="rvn_00000000000000000000000000000000")
                try:
                    override.list_assets()
                    check("explicit api_key beats a wrong env key (401)", False)
                except RvnApiError as err:
                    check("explicit api_key beats a wrong env key (401)",
                          err.status == 401, err)
            finally:
                del os.environ["RVN_API_KEY"]

            auth_tools = get_tools(keyed)
            auth_by_name = {t.name: t for t in auth_tools}
            tool_auth_issue = json.loads(auth_by_name["issue_asset"].invoke(
                {"name": "AUTHTOOL", "qty": "50", "to_address": DEST}))
            check("tool issue ALLOWs through the keyed client",
                  tool_auth_issue["decision"]["kind"] == "ALLOW", tool_auth_issue)
            tool_no_key = json.loads(
                get_tools(no_key)[0].invoke(
                    {"name": "AUTHNOKEY", "qty": "50", "to_address": DEST}))
            check("tool without a key returns a 401 error object",
                  tool_no_key.get("status") == 401, tool_no_key)
            auth_audit = keyed.get_audit()
            check("auth-on audit chain valid", auth_audit.get("chainValid") is True,
                  auth_audit)
        finally:
            kill_api(auth_child)
    finally:
        kill_api(child)

    print(f"\n{'ALL GREEN' if failures == 0 else f'{failures} FAILURES'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
