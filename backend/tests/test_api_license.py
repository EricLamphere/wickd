"""Tests for /api/license — the licensing status/activation endpoints.

Mocks app.licensing.polar_client at the network boundary (never hits the
real Polar API). Uses the autouse `override_db` fixture from conftest.py.
"""

from unittest.mock import AsyncMock, patch

from httpx import ASGITransport, AsyncClient

from app.licensing.polar_client import LicenseKeyState
from app.main import app


async def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_get_status_no_key_set() -> None:
    async with await _client() as client:
        r = await client.get("/api/license")

    assert r.status_code == 200
    body = r.json()
    assert body["has_key"] is False
    assert body["license_key"] is None
    assert body["entitled"] is False
    assert body["reason"] == "not_licensed"
    assert body["checked_at"] is None
    assert body["limit_activations"] is None


async def test_set_license_key_activates_and_validates() -> None:
    with patch(
        "app.licensing.entitlements.polar_client.activate", new=AsyncMock(return_value="act_123")
    ), patch(
        "app.licensing.entitlements.polar_client.validate",
        new=AsyncMock(
            return_value=LicenseKeyState(
                status="granted",
                expires_at=None,
                activation_id="act_123",
                customer_id="cust_123",
                license_key_id="lk_123",
                limit_activations=2,
            )
        ),
    ):
        async with await _client() as client:
            r = await client.put("/api/license", json={"license_key": "WICKD_-TEST-KEY"})

    assert r.status_code == 200
    body = r.json()
    assert body["has_key"] is True
    assert body["license_key"] == "WICKD_-TEST-KEY"
    assert body["entitled"] is True
    assert body["reason"] == "granted"
    assert body["status"] == "granted"
    assert body["checked_at"] is not None
    assert body["limit_activations"] == 2


async def test_set_license_key_not_entitled() -> None:
    from app.licensing.polar_client import LicenseKeyNotEntitled

    with patch(
        "app.licensing.entitlements.polar_client.activate",
        new=AsyncMock(side_effect=LicenseKeyNotEntitled("canceled")),
    ):
        async with await _client() as client:
            r = await client.put("/api/license", json={"license_key": "WICKD_-CANCELED-KEY"})

    assert r.status_code == 200
    body = r.json()
    assert body["entitled"] is False
    assert body["reason"] == "not_entitled"


async def test_clear_license_key() -> None:
    with patch(
        "app.licensing.entitlements.polar_client.activate", new=AsyncMock(return_value="act_123")
    ), patch(
        "app.licensing.entitlements.polar_client.validate",
        new=AsyncMock(return_value=LicenseKeyState(status="granted", expires_at=None, activation_id="act_123")),
    ):
        async with await _client() as client:
            await client.put("/api/license", json={"license_key": "WICKD_-TEST-KEY"})
            r = await client.put("/api/license", json={"license_key": None})

    assert r.status_code == 200
    body = r.json()
    assert body["has_key"] is False
    assert body["entitled"] is False
    assert body["reason"] == "not_licensed"


async def test_recheck_forces_fresh_check() -> None:
    with patch(
        "app.licensing.entitlements.polar_client.activate", new=AsyncMock(return_value="act_123")
    ), patch(
        "app.licensing.entitlements.polar_client.validate",
        new=AsyncMock(return_value=LicenseKeyState(status="granted", expires_at=None, activation_id="act_123")),
    ) as mock_validate:
        async with await _client() as client:
            await client.put("/api/license", json={"license_key": "WICKD_-TEST-KEY"})
            r = await client.post("/api/license/recheck")

    assert r.status_code == 200
    assert r.json()["entitled"] is True
    # Called once during PUT (initial check) and once during the forced recheck.
    assert mock_validate.await_count == 2


async def test_checkout_url_included_when_configured() -> None:
    from app.config import settings

    original = settings.polar_sandbox_checkout_url
    settings.polar_sandbox_checkout_url = "https://polar.sh/lamphere-labs/checkout/test"
    try:
        async with await _client() as client:
            r = await client.get("/api/license")
        assert r.json()["checkout_url"] == "https://polar.sh/lamphere-labs/checkout/test"
    finally:
        settings.polar_sandbox_checkout_url = original


async def test_status_has_no_api_key_features() -> None:
    """Cancel and device count needed Polar's org API key, which must never
    ship in the desktop app; both live in the customer portal instead."""
    async with await _client() as client:
        body = (await client.get("/api/license")).json()

    assert "can_cancel" not in body
    assert "can_view_activations" not in body
    assert body["portal_url"]


async def test_cancel_and_activations_endpoints_removed() -> None:
    async with await _client() as client:
        cancel = await client.post("/api/license/cancel")
        activations = await client.get("/api/license/activations")

    assert cancel.status_code in (404, 405)
    assert activations.status_code in (404, 405)


def test_no_org_api_key_anywhere() -> None:
    from app.config import settings
    from app.licensing import polar_client

    assert not hasattr(settings, "polar_api_key")
    for name in ("get_activation_count", "create_customer_session", "list_active_subscription_ids", "cancel_subscription"):
        assert not hasattr(polar_client, name)
