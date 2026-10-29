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

from langchain_rvn import RvnApiClient, get_tools  # noqa: E402

API_PORT = 3124
API = f"http://127.0.0.1:{API_PORT}"
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


def boot_api():
    child = subprocess.Popen(
        [os.path.join(REPO, "node_modules", ".bin", "tsx"),
         os.path.join(REPO, "src", "server.ts")],
        env={**os.environ, "PORT": str(API_PORT), "MOCK_RVN": "true"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        # tsx spawns a node child: kill the whole group, or the API survives
        # the test and its mock state leaks into the next run.
        start_new_session=True,
    )
    for _ in range(120):
        try:
            with urllib.request.urlopen(f"{API}/v1/health", timeout=2) as resp:
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

        issued = client.issue_asset("LCADAPTER", "100", DEST)
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
        check("17 tools built", len(tools) == 17, sorted(by_name))
        check("tool names cover every route",
              {"issue_asset", "reissue_asset", "issue_subasset", "issue_unique",
               "transfer_asset", "list_assets", "get_asset", "simulate_intent",
               "approve_intent", "deny_intent", "pending_intents", "get_policy",
               "set_policy", "list_presets", "apply_preset", "get_audit",
               "create_wallet"} == set(by_name))

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
    finally:
        kill_api(child)

    print(f"\n{'ALL GREEN' if failures == 0 else f'{failures} FAILURES'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
