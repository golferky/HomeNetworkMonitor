"""
db_proxy_client.py
Drop-in replacement for SQLite db_connect() in server.py.
Routes all DB operations through the QNAP epg_server.py HTTP API
instead of accessing Movies.db directly over SMB.

INSTALLATION:
1. Copy this file to ~/epg/db_proxy_client.py on the Mac
2. In server.py, add at the top:
       from db_proxy_client import ProxyConnection
3. Replace db_connect() and db_connect_quick() with:

       def db_connect():
           return ProxyConnection(QNAP_DB_URL)

       def db_connect_quick(timeout_seconds: float = 5.0):
           return ProxyConnection(QNAP_DB_URL, timeout=timeout_seconds)

4. Add near the top of server.py config section:
       QNAP_DB_URL = "http://192.168.1.176:5000/db/execute"
"""

import requests
import logging

log = logging.getLogger("epg")

QNAP_DB_URL = "http://192.168.1.176:5000/db/execute"
DEFAULT_TIMEOUT = 30


class ProxyCursor:
    """Mimics sqlite3.Cursor interface."""

    def __init__(self):
        self.rowcount = -1
        self.lastrowid = None
        self._rows = []
        self._pos = 0

    def fetchall(self):
        return self._rows

    def fetchone(self):
        if self._rows:
            return self._rows[0]
        return None

    def fetchmany(self, size=1):
        return self._rows[:size]

    def __iter__(self):
        return iter(self._rows)


class ProxyRow(dict):
    """Mimics sqlite3.Row — supports both dict and attribute access."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)

    def keys(self):
        return super().keys()

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


class ProxyConnection:
    """
    Mimics sqlite3.Connection interface.
    Routes SQL to QNAP epg_server.py /db/execute endpoint.
    Supports 'with' statement (context manager).
    Batches statements within a transaction for efficiency.
    """

    def __init__(self, url: str = QNAP_DB_URL, timeout: float = DEFAULT_TIMEOUT):
        self._url = url
        self._timeout = timeout
        self._pending = []          # buffered statements for transaction
        self._in_transaction = False
        self._closed = False

    # ── Context manager ───────────────────────────────────────────────────────

    def __enter__(self):
        self._in_transaction = True
        self._pending = []
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        self._closed = True
        return False

    # ── Core execute ──────────────────────────────────────────────────────────

    def execute(self, sql: str, params=None) -> ProxyCursor:
        """Execute a single SQL statement."""
        sql = sql.strip()
        params = params or []

        # Convert named params dict to list isn't needed —
        # we pass params as-is; the server handles both
        if isinstance(params, dict):
            # Convert :name style to positional isn't needed since
            # we send params dict to server
            pass

        stmt = {
            "sql": sql,
            "params": params if isinstance(params, (list, dict)) else list(params),
            "fetch": self._infer_fetch(sql),
        }

        if self._in_transaction:
            # Buffer statement and execute immediately to get results
            return self._execute_single(stmt, transaction=False)
        else:
            return self._execute_single(stmt, transaction=True)

    def executemany(self, sql: str, seq_of_params) -> ProxyCursor:
        """Execute SQL for each set of params."""
        cursor = ProxyCursor()
        total_rowcount = 0
        statements = [
            {
                "sql": sql.strip(),
                "params": list(p) if not isinstance(p, dict) else p,
                "fetch": "none",
            }
            for p in seq_of_params
        ]

        # Send in batches of 500
        batch_size = 500
        for i in range(0, len(statements), batch_size):
            batch = statements[i:i + batch_size]
            resp = self._post(batch, transaction=True)
            for result in resp.get("results", []):
                total_rowcount += result.get("rowcount", 0)

        cursor.rowcount = total_rowcount
        return cursor

    def commit(self):
        """Flush any pending buffered statements."""
        self._in_transaction = False
        self._pending = []

    def rollback(self):
        """Discard pending statements."""
        self._in_transaction = False
        self._pending = []

    def close(self):
        self._closed = True

    # ── PRAGMA passthrough (no-op for most) ──────────────────────────────────

    def _is_pragma(self, sql: str) -> bool:
        return sql.upper().startswith("PRAGMA")

    # ── Internal ──────────────────────────────────────────────────────────────

    def _infer_fetch(self, sql: str) -> str:
        upper = sql.upper().lstrip()
        if upper.startswith("SELECT") or upper.startswith("WITH"):
            return "all"
        return "none"

    def _execute_single(self, stmt: dict, transaction: bool) -> ProxyCursor:
        # Skip PRAGMAs silently
        if self._is_pragma(stmt["sql"]):
            return ProxyCursor()

        resp = self._post([stmt], transaction=transaction)
        results = resp.get("results", [{}])
        result = results[0] if results else {}

        cursor = ProxyCursor()
        cursor.rowcount = result.get("rowcount", -1)
        cursor.lastrowid = result.get("lastrowid")

        raw_rows = result.get("rows", [])
        cursor._rows = [ProxyRow(r) for r in raw_rows]

        return cursor

    def _post(self, statements: list, transaction: bool = True) -> dict:
        try:
            resp = requests.post(
                self._url,
                json={"statements": statements, "transaction": transaction},
                timeout=self._timeout,
            )
            data = resp.json()
            if not data.get("ok"):
                error = data.get("error", "Unknown DB proxy error")
                log.error(f"DB proxy error: {error}")
                raise Exception(error)
            return data
        except requests.exceptions.ConnectionError as e:
            log.error(f"DB proxy connection failed: {e}")
            raise Exception(f"Cannot reach QNAP DB server: {e}")
        except requests.exceptions.Timeout:
            log.error("DB proxy timeout")
            raise Exception("DB proxy request timed out")


def test_proxy():
    """Quick test — run from Mac terminal to verify connectivity."""
    print("Testing DB proxy connection to QNAP...")
    try:
        con = ProxyConnection()
        with con:
            row = con.execute("SELECT COUNT(*) as cnt FROM guide").fetchone()
            print(f"✓ Guide rows: {row['cnt']}")
            row = con.execute("SELECT COUNT(*) as cnt FROM scheduled_recordings").fetchone()
            print(f"✓ Scheduled recordings: {row['cnt']}")
        print("✓ DB proxy working!")
    except Exception as e:
        print(f"✗ Error: {e}")


if __name__ == "__main__":
    test_proxy()
