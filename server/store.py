"""
store.py — SQLite 저장소.

CLAUDE.md 3절: SQLite 쓰기는 **5초 단위 트랜잭션 배치**로 SD카드 마모를 최소화한다.
그동안의 레코드는 메모리 버퍼에 모아 두었다가 한 트랜잭션으로 커밋한다.

테이블은 CLAUDE.md 1절 측정 레코드 스키마 그대로 9컬럼이다(추가 컬럼 없음).
    ts, survey, ec, tds, temp, depth, lat, lon, status

2026-08-10 스키마 변경: `ph` → `tds` (pH 센서 제외, EC/TDS 일체형 확정).
**기존 개발 DB 와 비호환이다.** 마이그레이션은 하지 않는다 — 구스키마를 발견하면
조용히 덮어쓰거나 섞어 쓰지 않고 명확한 안내 후 기동을 중단한다 (CLAUDE.md 6절:
오래된/뒤섞인 데이터를 정상처럼 보여주는 것이 최악의 버그).
"""

import asyncio
import os
import sqlite3
import threading
import time

from config import COMMIT_INTERVAL_SECONDS, DB_PATH

COLUMNS = ["ts", "survey", "ec", "tds", "temp", "depth", "lat", "lon", "status"]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
  ts      INTEGER NOT NULL,
  survey  INTEGER NOT NULL,
  ec      REAL,
  tds     REAL,
  temp    REAL,
  depth   REAL    NOT NULL,
  lat     REAL,
  lon     REAL,
  status  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_survey ON records(survey, ts);
"""


class IncompatibleSchemaError(RuntimeError):
    """기존 DB 가 구스키마(ph 컬럼)일 때. 자동 변환하지 않는다."""


class Store:
    def __init__(self, path=DB_PATH):
        self.path = path
        self._buf = []                 # 아직 커밋되지 않은 레코드
        self._lock = threading.Lock()  # sqlite 호출은 to_thread 로 나가므로 스레드 락
        self._conn = None
        self.commits = 0
        self.written = 0

    # ── 수명주기 ──────────────────────────────────────────────────────────
    def _check_schema(self):
        """기존 records 테이블이 현재 스키마와 같은지 확인. 다르면 기동 중단.

        구스키마(ph 컬럼)는 자동 변환하지 않는다 — 사용자가 백업 여부를 결정한다.
        """
        rows = self._conn.execute("PRAGMA table_info(records)").fetchall()
        if not rows:
            return                                   # 새 DB — 아래에서 생성한다
        cols = [r["name"] for r in rows]
        if cols == COLUMNS:
            return

        legacy = "ph" in cols
        lines = [
            "",
            "═" * 70,
            "[store] 기존 DB 의 records 테이블이 현재 스키마와 다릅니다 — 기동을 중단합니다.",
            f"    DB 경로 : {os.path.abspath(self.path)}",
            f"    기존 컬럼: {', '.join(cols)}",
            f"    필요 컬럼: {', '.join(COLUMNS)}",
        ]
        if legacy:
            lines += [
                "",
                "    pH 센서 제외·EC/TDS 일체형 확정(2026-08-10)으로 `ph` → `tds` 로 바뀌었습니다.",
                "    두 스키마를 섞어 쓰면 뒤섞인 값이 정상처럼 보이므로(CLAUDE.md 6절)",
                "    자동 변환하지 않습니다.",
            ]
        lines += [
            "",
            "    해결 방법 (둘 중 하나):",
            "      ① 기존 DB 를 백업한 뒤 삭제하고 새로 시작",
            f"         mv '{self.path}' '{self.path}.ph.bak'",
            "      ② 새 경로를 지정해 기존 DB 를 그대로 보존",
            "         UWD_DB=/path/to/records_tds.db uvicorn app:app --host 0.0.0.0 --port 8000",
            "",
            "    기존 데이터가 필요하면 백업본을 sqlite3 로 직접 조회하세요(변환 스크립트 없음).",
            "═" * 70,
            "",
        ]
        print("\n".join(lines), flush=True)
        raise IncompatibleSchemaError(
            f"records 테이블 스키마 불일치: {cols} != {COLUMNS} "
            f"({os.path.abspath(self.path)})"
        )

    def open(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # 정전(현장 배터리)에 대비: WAL + FULL 동기화. 커밋 자체가 5초에 한 번뿐이다.
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        try:
            self._check_schema()
        except Exception:
            self.close()
            raise
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ── 쓰기 ─────────────────────────────────────────────────────────────
    def add(self, rec):
        """측정 레코드 1건을 배치 버퍼에 넣는다(즉시 디스크에 쓰지 않는다)."""
        self._buf.append(tuple(rec[c] for c in COLUMNS))

    def _flush_blocking(self):
        with self._lock:
            if not self._buf:
                return 0
            rows, self._buf = self._buf, []
            cur = self._conn.cursor()
            cur.execute("BEGIN")
            cur.executemany(
                "INSERT INTO records (ts,survey,ec,tds,temp,depth,lat,lon,status) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                rows,
            )
            self._conn.commit()
            self.commits += 1
            self.written += len(rows)
            return len(rows)

    async def flush(self):
        return await asyncio.to_thread(self._flush_blocking)

    async def run_flusher(self):
        """5초마다 배치 커밋."""
        next_t = time.monotonic()
        while True:
            next_t += COMMIT_INTERVAL_SECONDS
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))
            await self.flush()

    @property
    def pending(self):
        return len(self._buf)

    # ── 읽기 (블로킹 — REST 핸들러에서 to_thread 로 감싸 호출) ─────────────
    def _q(self, sql, args=()):
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def next_survey(self):
        """서버 재기동 시 이어쓰기: 기존 최대 차수 + 1."""
        row = self._q("SELECT MAX(survey) AS m FROM records")[0]
        return (row["m"] or 0) + 1

    def surveys(self):
        rows = self._q(
            "SELECT survey, COUNT(*) AS count, MIN(ts) AS start_ts, MAX(ts) AS end_ts, "
            "SUM(status='fault') AS fault "
            "FROM records GROUP BY survey ORDER BY survey"
        )
        return [dict(r) for r in rows]

    def records(self, survey, limit=None):
        sql = ("SELECT ts,survey,ec,tds,temp,depth,lat,lon,status FROM records "
               "WHERE survey=? ORDER BY ts")
        args = [survey]
        if limit:
            sql += " LIMIT ?"
            args.append(int(limit))
        return [dict(r) for r in self._q(sql, tuple(args))]

    def count(self, survey=None):
        if survey is None:
            return self._q("SELECT COUNT(*) AS c FROM records")[0]["c"]
        return self._q("SELECT COUNT(*) AS c FROM records WHERE survey=?", (survey,))[0]["c"]
