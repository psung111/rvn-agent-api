# langchain-rvn

LangChain tools wrapping the [rvn-agent-api](../README.md) REST API — the
policy-gated Ravencoin asset API. An agent never touches the node directly:
it submits an intent, the policy engine decides ALLOW / REQUIRE_APPROVAL /
DENY, and every step lands in a hash-chained audit log. These tools proxy to
the REST API exactly like the MCP server does, so the policy engine stays
the single enforcement point.

## Install

From a checkout of this repo (the package is not on PyPI yet — publishing
is one `twine upload` away once a PyPI account is set up):

```bash
pip install ./langchain_rvn
# or, for development against the checkout:
pip install -e ./langchain_rvn
```

This installs `langchain-core` as well. The stdlib-only client
(`langchain_rvn.client.RvnApiClient`) works without it; only `get_tools()`
needs it.

## Usage

```python
from langchain_rvn import RvnApiClient, get_tools

client = RvnApiClient("http://127.0.0.1:3001", agent_id="agent-1")
tools = get_tools(client)  # 17 StructuredTools, one per API route
# hand `tools` to any LangChain agent executor
```

Tool results are JSON strings: a decision payload (ALLOW /
REQUIRE_APPROVAL / DENY with reason codes, plus `txid` when executed), a
held intent id (never an error — approve it only after a human approves),
or `{"error", "status"}` when the API rejects the call. Always
`simulate_intent` before acting when unsure — a simulation has zero side
effects (no persisted intent, no spend recorded, no audit entry).

## Worked example

`examples/agent_executor.py` runs a complete tool-calling agent loop
against a local API on the mock node — no LLM key, no network beyond
localhost, no real funds. It uses langchain-core's deterministic
`GenericFakeChatModel` in place of a real chat model, so the conversation
is scripted and repeatable; swapping in a real model (e.g. `ChatOpenAI`
with `.bind_tools(tools)`) turns the same loop into a live agent. Run it
with the API already up (`pnpm dev` from the repo root, `MOCK_RVN=true`
by default):

```bash
python3 langchain_rvn/examples/agent_executor.py
# RVN_API_URL=http://127.0.0.1:3001 RVN_AGENT_ID=agent-1 python3 langchain_rvn/examples/agent_executor.py
```

The adapter test suite (`pnpm test:langchain` from the repo root) boots
its own API and exercises the client and every tool against it.

## License

GNU Affero General Public License v3.0 — see [LICENSE](../LICENSE).
