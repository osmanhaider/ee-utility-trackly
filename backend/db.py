"""Small async DB adapter for local SQLite and production Postgres.

The app started life on SQLite (`aiosqlite`) and most backend code uses this
shape:

    async with _db() as db:
        async with db.execute("SELECT ... WHERE id = ?", (id,)) as c:
            row = await c.fetchone()

This adapter preserves that shape while swapping to asyncpg when DATABASE_URL is
set (Supabase / Postgres). It intentionally stays tiny: placeholder conversion,
mapping rows, rowcount, and commit no-op for Postgres.
"""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Iterable

import aiosqlite

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_POSTGRES = bool(DATABASE_URL)


class IntegrityError(Exception):
    """Raised for uniqueness / constraint violations across DB backends."""


def is_postgres() -> bool:
    return bool(os.environ.get("DATABASE_URL", "").strip())


def public_condition(alias: str | None = None) -> str:
    """DB-neutral public-bill predicate used by community queries."""
    col = f"{alias}.is_private" if alias else "is_private"
    if is_postgres():
        return f"COALESCE({col}, false) = false"
    return f"COALESCE({col}, 0) = 0"


def convert_placeholders(sql: str) -> str:
    """Convert SQLite `?` placeholders to asyncpg `$1`, `$2`, ...

    The queries in this app don't use literal question marks inside string
    values, so a simple left-to-right replacement is sufficient and more
    predictable than trying to parse SQL.
    """
    counter = 0

    def repl(_match: re.Match[str]) -> str:
        nonlocal counter
        counter += 1
        return f"${counter}"

    return re.sub(r"\?", repl, sql)


@dataclass
class Result:
    rowcount: int = -1


class Row(dict):
    """Mapping row that also supports integer indexing like sqlite rows."""

    def __init__(self, keys: Iterable[str], values: Iterable[Any]):
        self._keys = list(keys)
        super().__init__(zip(self._keys, values, strict=False))

    def __getitem__(self, key: str | int) -> Any:
        if isinstance(key, int):
            return super().__getitem__(self._keys[key])
        return super().__getitem__(key)


class Cursor:
    def __init__(self, rows: list[Any] | None = None, rowcount: int = -1):
        self._rows = rows or []
        self.rowcount = rowcount

    async def fetchone(self):
        return self._rows[0] if self._rows else None

    async def fetchall(self):
        return self._rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class ExecuteOperation:
    def __init__(self, conn: "BaseConnection", sql: str, params: tuple[Any, ...]):
        self.conn = conn
        self.sql = sql
        self.params = params
        self._cursor: Cursor | None = None

    def __await__(self):
        return self._run().__await__()

    async def _run(self) -> Cursor:
        self._cursor = await self.conn._execute(self.sql, self.params)
        return self._cursor

    async def __aenter__(self):
        if self._cursor is None:
            self._cursor = await self._run()
        return self._cursor

    async def __aexit__(self, exc_type, exc, tb):
        return False


class BaseConnection:
    row_factory = None

    def execute(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> ExecuteOperation:
        return ExecuteOperation(self, sql, tuple(params))

    async def _execute(self, sql: str, params: tuple[Any, ...]) -> Cursor:
        raise NotImplementedError

    async def commit(self) -> None:
        return None


class SQLiteConnection(BaseConnection):
    def __init__(self, conn: aiosqlite.Connection):
        self.conn = conn
        self.conn.row_factory = aiosqlite.Row

    async def _execute(self, sql: str, params: tuple[Any, ...]) -> Cursor:
        try:
            cur = await self.conn.execute(sql, params)
        except aiosqlite.IntegrityError as e:
            raise IntegrityError(str(e)) from e
        # For sqlite we keep the actual cursor object; it already has async
        # fetchone/fetchall and rowcount.
        return cur  # type: ignore[return-value]

    async def commit(self) -> None:
        await self.conn.commit()


class PostgresConnection(BaseConnection):
    def __init__(self, conn: Any):
        self.conn = conn

    async def _execute(self, sql: str, params: tuple[Any, ...]) -> Cursor:
        import asyncpg

        pg_sql = convert_placeholders(sql)
        stripped = sql.lstrip().lower()
        try:
            if stripped.startswith("select") or stripped.startswith("with"):
                records = await self.conn.fetch(pg_sql, *params)
                rows = [Row(r.keys(), r.values()) for r in records]
                return Cursor(rows=rows, rowcount=len(rows))
            status = await self.conn.execute(pg_sql, *params)
        except asyncpg.UniqueViolationError as e:
            raise IntegrityError(str(e)) from e
        except asyncpg.PostgresError:
            raise
        rowcount = _rowcount_from_status(status)
        return Cursor(rowcount=rowcount)


def _rowcount_from_status(status: str) -> int:
    # asyncpg statuses look like: "INSERT 0 1", "UPDATE 2", "DELETE 0".
    try:
        return int(status.rsplit(" ", 1)[-1])
    except (ValueError, IndexError):
        return -1


@asynccontextmanager
async def connect(sqlite_path: str = "bills.db", sqlite_timeout: float = 10.0):
    if is_postgres():
        import asyncpg

        # Supabase's transaction pooler does not play well with asyncpg's
        # prepared-statement cache. Disabling it keeps both pooler and direct
        # URLs working with the same configuration.
        conn = await asyncpg.connect(
            os.environ["DATABASE_URL"],
            statement_cache_size=0,
        )
        try:
            yield PostgresConnection(conn)
        finally:
            await conn.close()
    else:
        async with aiosqlite.connect(sqlite_path, timeout=sqlite_timeout) as conn:
            yield SQLiteConnection(conn)
