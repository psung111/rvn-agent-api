"""Worked LangChain agent-executor example against rvn-agent-api.

    # terminal 1 — start the API on the mock node (default, no real funds):
    pnpm dev
    # terminal 2 — run the example:
    python3 langchain_rvn/examples/agent_executor.py

    RVN_API_URL / RVN_AGENT_ID override the API address and agent id.

The "agent" here is langchain-core's deterministic GenericFakeChatModel
with a scripted conversation, so the run is repeatable with no LLM key
and no network beyond localhost: it allowlists the destination in the
example agent's policy first (the default policy holds issues to unknown
destinations), then simulates an issue (a dry run with zero side
effects), issues the asset for real, then reads the audit tail to
verify what happened. Swap the fake model for a real chat model
bound to the tools (``model.bind_tools(tools)``) and the same loop below
becomes a live agent — the tool-calling loop, not the model, is the
example. A held intent is never auto-approved: REQUIRE_APPROVAL returns
an intent id that waits for a human, exactly as with the REST API.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, REPO)

from langchain_core.language_models.fake_chat_models import (  # noqa: E402
    GenericFakeChatModel,
)
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage  # noqa: E402

from langchain_rvn import RvnApiClient, get_tools  # noqa: E402

API = os.environ.get("RVN_API_URL", "http://127.0.0.1:3001")
AGENT = os.environ.get("RVN_AGENT_ID", "example-agent")
DEST = "RExampleDestinationAddress1111111111"

# Scripted conversation: simulate -> issue -> audit, then a final answer.
# The fake model returns these in order regardless of the input, which is
# what makes the example deterministic without a real LLM.
SCRIPT = [
    AIMessage(
        content="",
        tool_calls=[
            {
                "name": "simulate_intent",
                "args": {
                    "op": "issue",
                    "asset_name": "EXAMPLECOIN",
                    "qty": "100",
                    "destination": DEST,
                },
                "id": "call_sim",
                "type": "tool_call",
            }
        ],
    ),
    AIMessage(
        content="",
        tool_calls=[
            {
                "name": "issue_asset",
                "args": {"name": "EXAMPLECOIN", "qty": "100", "to_address": DEST},
                "id": "call_issue",
                "type": "tool_call",
            }
        ],
    ),
    AIMessage(
        content="",
        tool_calls=[
            {"name": "get_audit", "args": {"limit": 5}, "id": "call_audit",
             "type": "tool_call"}
        ],
    ),
    AIMessage(content="EXAMPLECOIN issued (100 units) and verified in the audit log."),
]


def main() -> int:
    client = RvnApiClient(API, agent_id=AGENT)
    try:
        health = client.health()
    except Exception as err:
        print(f"API at {API} is not reachable — start it first (pnpm dev): {err}")
        return 2
    if not health.get("ok"):
        print(f"API at {API} is unhealthy: {health}")
        return 2

    # The default policy holds issues to destinations it has never seen,
    # so allowlist this example's destination before the agent loop runs.
    policy = client.get_policy()
    policy["allowedDestinations"] = [DEST]
    client.set_policy(policy)
    print(f"policy: allowlisted {DEST} for agent {AGENT}")

    tools = {t.name: t for t in get_tools(client)}
    model = GenericFakeChatModel(messages=iter(SCRIPT))
    messages: list = [HumanMessage(
        content="Simulate issuing 100 EXAMPLECOIN to my destination, then "
        "issue it for real, then confirm it in the audit log.")]
    for _ in range(10):
        reply = model.invoke(messages)
        messages.append(reply)
        if not reply.tool_calls:
            print(f"agent: {reply.content}")
            return 0
        for call in reply.tool_calls:
            tool = tools.get(call["name"])
            if tool is None:
                print(f"agent called unknown tool {call['name']!r}; stopping")
                return 1
            result = tool.invoke(call["args"])
            print(f"tool {call['name']} -> {result}")
            messages.append(ToolMessage(content=result, tool_call_id=call["id"]))
            parsed = json.loads(result)
            if parsed.get("decision", {}).get("kind") == "REQUIRE_APPROVAL":
                # Never auto-approve a hold: report the intent id and stop.
                print(f"held for human approval: {parsed['intent']['id']}; stopping")
                return 0
    print("agent loop did not finish within 10 turns")
    return 1


if __name__ == "__main__":
    sys.exit(main())
