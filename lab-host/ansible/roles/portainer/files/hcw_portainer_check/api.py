"""Portainer's API on the host's loopback: GET only, no proxy, no redirect."""

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

from .common import Failure, Unreachable

HTTP_TIMEOUT_SECONDS = 20


# Verification is off, which is safe on the loopback and nowhere else.
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib would follow a redirect and send the token header with it.
    # Portainer on the loopback never redirects an API call; refuse it if it does.
    def redirect_request(self, *args, **kwargs):
        """Refuse every redirect, so the token header never follows one."""
        return None


class Portainer:
    """Portainer's API on the host's loopback: GET only, no proxy, no redirect."""

    def __init__(self, url):
        """A client for the Portainer at url, which must be on the loopback."""
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("https", "http") or parts.hostname not in LOOPBACK_HOSTS:
            raise Failure(
                f"refusing the Portainer URL {url}: certificate verification is off, which is safe on the "
                "loopback only, so the role publishes Portainer on 127.0.0.1 and this helper reads it there"
            )
        self.url = url.rstrip("/") + "/api"
        # Portainer's certificate on 9443 is the one it generates for itself,
        # and the address is the loopback, checked above: there is no name to
        # verify and no network between the two ends.
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), _NoRedirect
        )

    def get(self, path, token, timeout=HTTP_TIMEOUT_SECONDS):
        """(HTTP status, parsed JSON or None) of one GET. Unreachable when Portainer did not answer."""
        request = urllib.request.Request(self.url + path, method="GET")
        request.add_header("X-API-Key", token)
        request.add_header("Accept", "application/json")
        try:
            with self.opener.open(request, timeout=timeout) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, b""
            error.close()
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise Unreachable(f"Portainer did not answer at {self.url} ({type(reason).__name__})") from None
        if not 200 <= status < 300 or not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except ValueError:
            raise Failure(f"Portainer's answer to GET {path.split('?')[0]} is not JSON") from None
