"""Where broker API traffic originates.

Brokers whitelist a source address for the **trading** APIs — orders,
positions, funds — while leaving OAuth login open. An engine that logs in
successfully from an unwhitelisted address then has every order refused, which
is a confusing failure to debug from the symptom.

So a trading client may name a proxy. When it does, trading calls are routed
through it and originate from the whitelisted address; when it does not, they
go directly from this machine, which then has to *be* that address.

Whether *login* is routed depends on where it happens, which is a property of
the broker rather than a policy the engine chooses.

A browser-OAuth broker has the operator's browser complete the login and
redirects back with a token this process exchanges; that exchange is not gated
on source address, and the browser step could not be routed anyway. A
credentials broker posts a key and secret from this process and gets a session
back — that is a server-side call like any other, so it is whitelisted like any
other and must originate from the same address.

The reference engine could not do this for one broker because its vendor SDK
owned its own URLs with no hook to reroute them. Talking to broker HTTP APIs
directly removes that constraint.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

import httpx

from garuda.domain.errors import DomainError
from garuda.protocols.broker import LoginStyle

#: Port assumed when a proxy is given as a bare address. Squid's default, and
#: what the operator gets if they do not say otherwise.
DEFAULT_PROXY_PORT = 3128


def proxy_url(static_ip: str | None, *, default_port: int = DEFAULT_PROXY_PORT) -> str | None:
    """Normalise an operator's entry into a proxy URL, or None for direct.

    Accepts what an operator would reasonably type: a bare address, an address
    with a port, or a full URL. Refuses anything ambiguous rather than guessing
    — a proxy pointed at the wrong place fails as an authentication error at
    the broker, which is nearly impossible to trace back to a typo here.
    """
    if static_ip is None or not static_ip.strip():
        return None

    value = static_ip.strip()
    if "://" in value:
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https"):
            raise DomainError(f"proxy {value!r} must be http or https")
        if not parsed.hostname:
            raise DomainError(f"proxy {value!r} names no host")
        port = parsed.port or default_port
        return f"{parsed.scheme}://{parsed.hostname}:{port}"

    host, separator, port_text = value.rpartition(":")
    if separator and port_text.isdigit():
        return f"http://{_validated_host(host)}:{int(port_text)}"
    return f"http://{_validated_host(value)}:{default_port}"


def _validated_host(host: str) -> str:
    host = host.strip("[]")
    if not host:
        raise DomainError("a proxy address names no host")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        # A hostname is fine too; only obviously malformed values are refused.
        if any(character.isspace() for character in host) or "/" in host:
            raise DomainError(f"proxy address {host!r} is not a host") from None
    return host


def trading_client_factory(static_ip: str | None, *, timeout: float = 10.0) -> httpx.AsyncClient:
    """An HTTP client for a broker's trading APIs, routed if configured."""
    return httpx.AsyncClient(proxy=proxy_url(static_ip), timeout=timeout)


def login_client_factory(
    static_ip: str | None,
    style: LoginStyle,
    *,
    timeout: float = 30.0,
) -> httpx.AsyncClient:
    """An HTTP client for a broker login, routed only when the login is ours.

    A browser-OAuth login is not proxied: routing it would add a way to fail
    without adding anything, since it is not gated on source address. A
    credentials login is proxied exactly like a trading call, because that is
    what it is.

    The longer default timeout is because a login can sit behind a human
    completing a browser flow.
    """
    proxy = proxy_url(static_ip) if style.is_proxied else None
    return httpx.AsyncClient(proxy=proxy, timeout=timeout)
