"""LangChain tools wrapping the rvn-agent-api REST API.

Importing this module requires ``langchain-core`` (``pip install
langchain-core``); the client in :mod:`langchain_rvn.client` does not.
Every tool proxies to the REST API, so the policy engine stays the single
enforcement point — a tool call can no more bypass a cap, budget,
allowlist, or approval hold than a raw HTTP call can.

Tool results are JSON strings: a decision payload (ALLOW / REQUIRE_APPROVAL
/ DENY with reason codes, plus ``txid`` when executed) or
``{"error": ..., "status": ...}`` when the API rejects the call (400/404/
409/410/502). A held intent is not an error — the agent gets the intent id
back and should call ``approve_intent`` only after a human approves, or
``deny_intent`` to reject it.

Usage::

    from langchain_rvn import RvnApiClient, get_tools

    tools = get_tools(RvnApiClient("http://127.0.0.1:3001", agent_id="agent-1"))
    # hand `tools` to any LangChain agent executor
"""

from __future__ import annotations

import json
from typing import Any, Optional

from langchain_core.tools import tool

from .client import RvnApiClient, RvnApiError


def _dump(result: dict[str, Any]) -> str:
    return json.dumps(result, default=str)


def _error(err: RvnApiError) -> str:
    return json.dumps({"error": err.message, "status": err.status})


def build_tools(client: RvnApiClient) -> list:
    """Build the full LangChain tool list bound to one API client."""

    @tool
    def issue_asset(
        name: str,
        qty: str,
        to_address: str,
        units: int = 0,
        reissuable: bool = True,
        ipfs_hash: Optional[str] = None,
    ) -> str:
        """Issue a new Ravencoin root asset, policy-gated. qty is a base-unit
        decimal string (whole units at units=0). Returns the intent and its
        decision: ALLOW (with txid), REQUIRE_APPROVAL (held intent id), or
        DENY with reason codes."""
        try:
            return _dump(
                client.issue_asset(name, qty, to_address, units, reissuable, ipfs_hash)
            )
        except RvnApiError as err:
            return _error(err)

    @tool
    def reissue_asset(
        name: str,
        qty: str,
        to_address: str,
        reissuable: Optional[bool] = None,
        new_units: Optional[int] = None,
        new_ipfs_hash: Optional[str] = None,
    ) -> str:
        """Reissue an existing reissuable asset, growing its supply.
        Policy-gated exactly like an issue. new_ipfs_hash requires new_units
        (ravend params are positional)."""
        try:
            return _dump(
                client.reissue_asset(
                    name, qty, to_address, reissuable, new_units, new_ipfs_hash
                )
            )
        except RvnApiError as err:
            return _error(err)

    @tool
    def issue_subasset(
        name: str,
        qty: str,
        to_address: str,
        units: int = 0,
        reissuable: bool = True,
        ipfs_hash: Optional[str] = None,
    ) -> str:
        """Issue a sub-asset under an existing parent (name like
        PARENT/CHILD, nested PARENT/CHILD/GRAND works). Policy-gated exactly
        like an issue; the parent must exist."""
        try:
            return _dump(
                client.issue_subasset(name, qty, to_address, units, reissuable, ipfs_hash)
            )
        except RvnApiError as err:
            return _error(err)

    @tool
    def issue_unique(
        name: str,
        to_address: str,
        ipfs_hash: Optional[str] = None,
    ) -> str:
        """Issue a unique asset (Ravencoin NFT) named ROOT#TAG under an
        existing root. Singletons: qty is always 1, units 0, never
        reissuable."""
        try:
            return _dump(client.issue_unique(name, to_address, ipfs_hash))
        except RvnApiError as err:
            return _error(err)

    @tool
    def transfer_asset(asset_name: str, qty: str, destination: str) -> str:
        """Transfer an asset to a destination address, policy-gated. qty is
        a base-unit decimal string. Returns the intent and its decision."""
        try:
            return _dump(client.transfer_asset(asset_name, qty, destination))
        except RvnApiError as err:
            return _error(err)

    @tool
    def list_assets(pattern: str = "*") -> str:
        """List assets known to the node, optionally filtered by a glob
        pattern."""
        try:
            return _dump(client.list_assets(pattern))
        except RvnApiError as err:
            return _error(err)

    @tool
    def get_asset(name: str) -> str:
        """Get one asset's details (supply, units, reissuable, ipfs hash).
        Returns an error object for an unknown asset."""
        try:
            return _dump(client.get_asset(name))
        except RvnApiError as err:
            return _error(err)

    @tool
    def simulate_intent(
        op: str, asset_name: str, qty: str, destination: str
    ) -> str:
        """Dry-run an intent through the policy engine and return the
        decision it WOULD get (ALLOW / REQUIRE_APPROVAL / DENY with reason
        codes) — without persisting anything, recording spend, touching the
        audit chain, or executing. op is issue, transfer, reissue, subasset,
        or unique. Always simulate before acting when unsure."""
        try:
            return _dump(client.simulate_intent(op, asset_name, qty, destination))
        except RvnApiError as err:
            return _error(err)

    @tool
    def approve_intent(intent_id: str, approver: str = "human") -> str:
        """Approve a held intent. The intent executes on the node (unless
        re-evaluation denies it) and returns its txid. Only call this after
        a human has approved the hold — it moves real funds/supply."""
        try:
            return _dump(client.approve_intent(intent_id, approver))
        except RvnApiError as err:
            return _error(err)

    @tool
    def deny_intent(intent_id: str, approver: str = "human") -> str:
        """Deny a held intent. The intent never executes."""
        try:
            return _dump(client.deny_intent(intent_id, approver))
        except RvnApiError as err:
            return _error(err)

    @tool
    def pending_intents() -> str:
        """List intents currently waiting for human approval."""
        try:
            return _dump(client.pending_intents())
        except RvnApiError as err:
            return _error(err)

    @tool
    def get_policy() -> str:
        """Get the calling agent's current policy document."""
        try:
            return _dump(client.get_policy())
        except RvnApiError as err:
            return _error(err)

    @tool
    def set_policy(policy_json: str) -> str:
        """Replace the calling agent's policy wholesale. policy_json is a
        full policy document: version 1, agentId matching the client agent,
        and every policy field (caps, budgets, thresholds, destination
        lists, assetNamePattern, decisionTtlSeconds). Get the current policy
        first and edit it, rather than writing one from scratch."""
        try:
            policy = json.loads(policy_json)
        except (ValueError, TypeError) as err:
            return json.dumps({"error": f"policy_json is not valid JSON: {err}"})
        if not isinstance(policy, dict):
            return json.dumps({"error": "policy_json must be a JSON object"})
        try:
            return _dump(client.set_policy(policy))
        except RvnApiError as err:
            return _error(err)

    @tool
    def list_presets() -> str:
        """List the named policy presets (conservative, balanced,
        permissive) with their full policy documents."""
        try:
            return _dump(client.list_presets())
        except RvnApiError as err:
            return _error(err)

    @tool
    def apply_preset(preset: str, overrides_json: str = "") -> str:
        """Apply a named policy preset to the calling agent, optionally with
        per-agent field overrides given as a JSON object string. Same
        replace semantics as set_policy, audited as a preset application."""
        overrides: dict[str, Any] = {}
        if overrides_json:
            try:
                overrides = json.loads(overrides_json)
            except (ValueError, TypeError) as err:
                return json.dumps(
                    {"error": f"overrides_json is not valid JSON: {err}"}
                )
            if not isinstance(overrides, dict):
                return json.dumps({"error": "overrides_json must be a JSON object"})
        try:
            return _dump(client.apply_preset(preset, overrides))
        except RvnApiError as err:
            return _error(err)

    @tool
    def get_audit(limit: int = 50) -> str:
        """Read the tail of the hash-chained audit log with its chain
        validity flag. Use it to verify what actually happened."""
        try:
            return _dump(client.get_audit(limit))
        except RvnApiError as err:
            return _error(err)

    @tool
    def create_wallet() -> str:
        """Provision a fresh Ravencoin address for the calling agent."""
        try:
            return _dump(client.create_wallet())
        except RvnApiError as err:
            return _error(err)

    return [
        issue_asset,
        reissue_asset,
        issue_subasset,
        issue_unique,
        transfer_asset,
        list_assets,
        get_asset,
        simulate_intent,
        approve_intent,
        deny_intent,
        pending_intents,
        get_policy,
        set_policy,
        list_presets,
        apply_preset,
        get_audit,
        create_wallet,
    ]
