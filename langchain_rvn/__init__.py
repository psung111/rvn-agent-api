"""LangChain adapter for rvn-agent-api.

``RvnApiClient`` (stdlib-only) talks to the REST API; :func:`get_tools`
builds the LangChain tool list and is the only part that needs
``langchain-core`` installed.
"""

from .client import RvnApiClient, RvnApiError

__all__ = ["RvnApiClient", "RvnApiError", "get_tools"]


def get_tools(client: RvnApiClient) -> list:
    """Build the LangChain tool list bound to ``client``.

    Raises ImportError with install guidance when langchain-core is absent,
    so importing the package itself never fails on a bare Python install.
    """
    try:
        from .tools import build_tools
    except ImportError as err:
        raise ImportError(
            "langchain-core is required for LangChain tools: "
            "pip install langchain-core (the RvnApiClient works without it)"
        ) from err
    return build_tools(client)
