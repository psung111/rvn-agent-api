"""Stdlib-only HTTP client for the rvn-agent-api REST API.

No third-party dependencies: the client works wherever Python 3 runs, so a
LangChain agent (or any other caller) can talk to the API without dragging
in langchain-core. Tool construction lives in :mod:`langchain_rvn.tools`
and is the only part that needs langchain-core installed.

Conventions mirror the API itself:

* Quantities are base-unit decimal strings (``"100"`` means 100 whole units
  at units=0), never floats — the API compares them as big integers.
* ``agent_id`` defaults to the client's default agent; every method accepts
  an override.
* A DENY decision is a normal API outcome, not an error: submit routes
  return their ``{intent, decision}`` payload on HTTP 403 instead of
  raising. Anything else >= 400 raises :class:`RvnApiError`.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class RvnApiError(Exception):
    """An HTTP error from the API (4xx/5xx other than a DENY decision)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"rvn-agent-api HTTP {status}: {message}")
        self.status = status
        self.message = message


def _as_qty(value: Any) -> str:
    """Normalize an int/str quantity to the decimal string the API expects."""
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"qty must be an int or decimal string, got {value!r}")
    text = str(value)
    if not text.isdigit():
        raise ValueError(f"qty must be a non-negative integer string, got {value!r}")
    return text


class RvnApiClient:
    """Thin wrapper over the rvn-agent-api REST routes."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:3001",
        agent_id: str = "agent-1",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.agent_id = agent_id
        self.timeout = timeout

    # -- transport -----------------------------------------------------

    def _call(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        query: Optional[dict[str, str]] = None,
        pass_through: tuple[int, ...] = (403,),
    ) -> dict[str, Any]:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            payload = err.read().decode("utf-8")
            if err.code in pass_through:
                return _parse(payload)
            try:
                detail = _parse(payload).get("error", payload)
            except ValueError:
                detail = payload or err.reason
            raise RvnApiError(err.code, str(detail)) from err
        return _parse(payload)

    # -- health / wallets ----------------------------------------------

    def health(self) -> dict[str, Any]:
        return self._call("GET", "/v1/health")

    def create_wallet(self) -> dict[str, Any]:
        """Provision a fresh Ravencoin address for an agent."""
        return self._call("POST", "/v1/wallets", {})

    # -- asset operations (policy-gated; 403 payload = DENY decision) ---

    def issue_asset(
        self,
        name: str,
        qty: Any,
        to_address: str,
        units: int = 0,
        reissuable: bool = True,
        ipfs_hash: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "qty": _as_qty(qty),
            "toAddress": to_address,
            "agentId": agent_id or self.agent_id,
            "units": units,
            "reissuable": reissuable,
        }
        if ipfs_hash is not None:
            body["ipfsHash"] = ipfs_hash
        return self._call("POST", "/v1/assets/issue", body)

    def reissue_asset(
        self,
        name: str,
        qty: Any,
        to_address: str,
        reissuable: Optional[bool] = None,
        new_units: Optional[int] = None,
        new_ipfs_hash: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "qty": _as_qty(qty),
            "toAddress": to_address,
            "agentId": agent_id or self.agent_id,
        }
        if reissuable is not None:
            body["reissuable"] = reissuable
        if new_units is not None:
            body["newUnits"] = new_units
        if new_ipfs_hash is not None:
            body["newIpfsHash"] = new_ipfs_hash
        return self._call("POST", "/v1/assets/reissue", body)

    def issue_subasset(
        self,
        name: str,
        qty: Any,
        to_address: str,
        units: int = 0,
        reissuable: bool = True,
        ipfs_hash: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "qty": _as_qty(qty),
            "toAddress": to_address,
            "agentId": agent_id or self.agent_id,
            "units": units,
            "reissuable": reissuable,
        }
        if ipfs_hash is not None:
            body["ipfsHash"] = ipfs_hash
        return self._call("POST", "/v1/assets/issue-subasset", body)

    def issue_unique(
        self,
        name: str,
        to_address: str,
        ipfs_hash: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Issue a unique asset (``ROOT#TAG``); singletons, qty is always 1."""
        body: dict[str, Any] = {
            "name": name,
            "toAddress": to_address,
            "agentId": agent_id or self.agent_id,
        }
        if ipfs_hash is not None:
            body["ipfsHash"] = ipfs_hash
        return self._call("POST", "/v1/assets/issue-unique", body)

    def transfer_asset(
        self,
        asset_name: str,
        qty: Any,
        destination: str,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._call(
            "POST",
            "/v1/assets/transfer",
            {
                "assetName": asset_name,
                "qty": _as_qty(qty),
                "destination": destination,
                "agentId": agent_id or self.agent_id,
            },
        )

    def list_assets(self, pattern: str = "*") -> dict[str, Any]:
        return self._call("GET", "/v1/assets", query={"pattern": pattern})

    def get_asset(self, name: str) -> dict[str, Any]:
        return self._call(
            "GET", f"/v1/assets/{urllib.parse.quote(name, safe='')}",
            pass_through=(),
        )

    # -- intents / approvals --------------------------------------------

    def approve_intent(
        self, intent_id: str, approver: str = "human"
    ) -> dict[str, Any]:
        return self._call(
            "POST", f"/v1/intents/{intent_id}/approve", {"approver": approver}
        )

    def deny_intent(
        self, intent_id: str, approver: str = "human"
    ) -> dict[str, Any]:
        return self._call(
            "POST", f"/v1/intents/{intent_id}/deny", {"approver": approver}
        )

    def pending_intents(self) -> dict[str, Any]:
        return self._call("GET", "/v1/intents/pending")

    def simulate_intent(
        self,
        op: str,
        asset_name: str,
        qty: Any,
        destination: str,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Dry-run an intent: returns the decision with zero side effects.

        ``op`` is one of ``issue`` | ``transfer`` | ``reissue`` |
        ``subasset`` | ``unique``. The returned decision id is namespaced
        ``sim-`` and can never be approved or denied.
        """
        return self._call(
            "POST",
            "/v1/intents/simulate",
            {
                "op": op,
                "assetName": asset_name,
                "qty": _as_qty(qty),
                "destination": destination,
                "agentId": agent_id or self.agent_id,
            },
        )

    # -- policies / presets ----------------------------------------------

    def get_policy(self, agent_id: Optional[str] = None) -> dict[str, Any]:
        return self._call(
            "GET", f"/v1/policies/{agent_id or self.agent_id}"
        )

    def set_policy(self, policy: dict[str, Any]) -> dict[str, Any]:
        """Replace an agent's policy wholesale (needs version:1 + agentId)."""
        agent = policy.get("agentId") or self.agent_id
        return self._call("PUT", f"/v1/policies/{agent}", policy)

    def list_presets(self) -> dict[str, Any]:
        return self._call("GET", "/v1/policies/presets")

    def apply_preset(
        self,
        preset: str,
        overrides: Optional[dict[str, Any]] = None,
        agent_id: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._call(
            "POST",
            f"/v1/policies/{agent_id or self.agent_id}/preset",
            {"preset": preset, "overrides": overrides or {}},
        )

    # -- audit ------------------------------------------------------------

    def get_audit(self, limit: int = 50) -> dict[str, Any]:
        return self._call("GET", "/v1/audit", query={"limit": str(limit)})


def _parse(payload: str) -> dict[str, Any]:
    parsed = json.loads(payload) if payload else {}
    if not isinstance(parsed, dict):
        raise ValueError(f"unexpected non-object response: {payload!r}")
    return parsed
