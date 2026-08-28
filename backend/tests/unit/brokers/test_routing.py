"""Where broker API traffic originates."""

from __future__ import annotations

import pytest

from garuda.brokers.routing import (
    DEFAULT_PROXY_PORT,
    login_client_factory,
    proxy_url,
    trading_client_factory,
)
from garuda.domain.errors import DomainError


class TestDirect:
    @pytest.mark.parametrize("value", [None, "", "   "])
    def test_no_proxy_configured_means_direct(self, value):
        """The machine then has to be the whitelisted address itself."""
        assert proxy_url(value) is None

    async def test_the_trading_client_is_unproxied_when_nothing_is_configured(self):
        async with trading_client_factory(None) as client:
            assert client._mounts == {} or all(
                transport is None for transport in client._mounts.values()
            )


class TestNormalisation:
    """Accepts what an operator would reasonably type."""

    @pytest.mark.parametrize(
        ("entered", "expected"),
        [
            ("203.0.113.7", f"http://203.0.113.7:{DEFAULT_PROXY_PORT}"),
            ("203.0.113.7:8080", "http://203.0.113.7:8080"),
            ("http://203.0.113.7:3128", "http://203.0.113.7:3128"),
            ("https://proxy.internal:443", "https://proxy.internal:443"),
            ("proxy.example.com", f"http://proxy.example.com:{DEFAULT_PROXY_PORT}"),
            ("  203.0.113.7  ", f"http://203.0.113.7:{DEFAULT_PROXY_PORT}"),
        ],
    )
    def test_each_form_normalises_to_a_proxy_url(self, entered, expected):
        assert proxy_url(entered) == expected

    def test_a_url_without_a_port_takes_the_default(self):
        assert proxy_url("http://203.0.113.7") == f"http://203.0.113.7:{DEFAULT_PROXY_PORT}"

    def test_the_default_port_is_configurable(self):
        assert proxy_url("203.0.113.7", default_port=9999) == "http://203.0.113.7:9999"


class TestRejections:
    """A proxy pointed at the wrong place fails as an auth error at the broker."""

    @pytest.mark.parametrize("value", ["ftp://203.0.113.7", "socks5://203.0.113.7"])
    def test_a_scheme_that_is_not_http_is_refused(self, value):
        with pytest.raises(DomainError, match="must be http or https"):
            proxy_url(value)

    def test_a_url_with_no_host_is_refused(self):
        with pytest.raises(DomainError, match="names no host"):
            proxy_url("http://")

    def test_something_that_is_not_a_host_is_refused(self):
        with pytest.raises(DomainError, match="is not a host"):
            proxy_url("203.0.113.7/some/path")


class TestLoginIsNeverProxied:
    async def test_the_login_client_takes_no_proxy(self):
        """Login is not IP-restricted, so a proxy adds only a way to fail."""
        async with login_client_factory() as client:
            assert client._mounts == {} or all(
                transport is None for transport in client._mounts.values()
            )

    async def test_login_waits_longer_than_a_trading_call(self):
        """A login sits behind a human completing a browser flow."""
        async with login_client_factory() as login, trading_client_factory(None) as trading:
            assert login.timeout.read is not None
            assert trading.timeout.read is not None
            assert login.timeout.read > trading.timeout.read
