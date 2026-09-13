"""
store.py — SQLite 저장소.

CLAUDE.md 3절: SQLite 쓰기는 **5초 단위 트랜잭션 배치**로 SD카드 마모를 최소화한다.
그동안의 레코드는 메모리 버퍼에 모아 두었다가 한 트랜잭션으로 커밋한다.

테이블은 CLAUDE.md 1절 측정 레코드 스키마 그대로 13컬럼이다.
    ts, survey, ec, tds, temp, depth, lat, lon, status, samples, ec_sd, tds_sd, temp_sd

2026-08-28 스키마 변경: **한 수심 층에서 레코드 1건**(30초 측정의 대표값)으로 바뀌면서
품질 컬럼 4개가 붙었다 — `samples`(대표값에 쓴 표본 수), `*_sd`(그 표본들의 표준편차).
이전에는 1 Hz 로 30건이 쌓여 건수가 부풀었다.

2026-08-29 추가: **surveys 테이블** — 차수는 조사지(site)와 날짜(survey_date)에 매인다.
`round` 는 그 조사지·그 날짜 안에서만 1,2,3… 으로 올라간다. 저수지를 옮기면 다시 1차다
(사용자 확정 2026-08-29: 다른 저수지에서 4·5·6차가 되는 것을 막는다).
차수는 조작자가 "차수 시작"을 눌러야 생긴다 — **전원만 켜져 있다고 차수가 생기지 않는다.**

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

COLUMNS = ["ts", "survey", "ec", "tds", "temp", "depth", "lat", "lon", "status",
           "samples", "ec_sd", "tds_sd", "temp_sd"]

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
  status  TEXT    NOT NULL,
  samples INTEGER,           -- 대표값 산출에 쓴 표본 수 (0 이면 정상 표본 없음)
  ec_sd   REAL,              -- 그 표본들의 표준편차 (표본 1개면 NULL)
  tds_sd  REAL,
  temp_sd REAL
);
CREATE INDEX IF NOT EXISTS idx_records_survey ON records(survey, ts);

CREATE TABLE IF NOT EXISTS surveys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT    NOT NULL,      -- 조사지(저수지) 이름 — 조작자가 입력
  survey_date TEXT    NOT NULL,      -- 'YYYY-MM-DD' (현장 로컬 날짜)
  round       INTEGER NOT NULL,      -- 그 site+date 안에서의 차수 (1,2,3…)
  memo        TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_key ON surveys(site, survey_date, round);
"""

SURVEY_COLUMNS = ["id", "site", "survey_date", "round", "memo", "started_at", "ended_at"]


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
        srows = self._conn.execute("PRAGMA table_info(surveys)").fetchall()
        scols = [r["name"] for r in srows]
        if cols == COLUMNS and scols == SURVEY_COLUMNS:
            return
        if cols == COLUMNS and not scols:
            # records 는 최신인데 surveys 만 없다 — 조사지·차수를 알 수 없어 자동 변환하지 않는다.
            print("\n[store] surveys 테이블이 없습니다 — 조사지/차수 정보를 만들 수 없어 "
                  "기동을 중단합니다. 아래 안내대로 새 DB 로 시작하세요.", flush=True)

        legacy = "ph" in cols
        lines = [
            "",
            "═" * 70,
            "[store] 기존 DB 의 records 테이블이 현재 스키마와 다릅니다 — 기동을 중단합니다.",
            f"    DB 경로 : {os.path.abspath(self.path)}",
            f"    기존 컬럼: {', '.join(cols)}",
            f"    필요 컬럼: {', '.join(COLUMNS)}",
        ]
        if list(cols[:9]) == COLUMNS[:9] and len(cols) == 9:
            lines += [
                "",
                "    2026-08-28 부터 **한 수심 층에 레코드 1건**(30초 측정의 대표값)만 쌓고",
                "    품질 컬럼(samples, ec_sd, tds_sd, temp_sd)을 함께 저장합니다.",
                "    구스키마 DB 에는 1초마다 1건씩 쌓인 옛 레코드가 들어 있어 건수 의미가 달라",
                "    섞어 쓰지 않습니다 (CLAUDE.md 6절).",
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
                "INSERT INTO records "
                "(ts,survey,ec,tds,temp,depth,lat,lon,status,samples,ec_sd,tds_sd,temp_sd) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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

    # ── 차수(surveys) ────────────────────────────────────────────────────
    def next_round(self, site, survey_date):
        """그 조사지·그 날짜의 다음 차수 번호. 조사지나 날짜가 바뀌면 다시 1차다."""
        row = self._q(
            "SELECT MAX(round) AS m FROM surveys WHERE site=? AND survey_date=?",
            (site, survey_date),
        )[0]
        return (row["m"] or 0) + 1

    def create_survey(self, site, survey_date, memo, started_at):
        """차수 1건을 연다. 조작자가 '차수 시작'을 눌렀을 때만 호출된다."""
        rnd = self.next_round(site, survey_date)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "INSERT INTO surveys (site,survey_date,round,memo,started_at,ended_at) "
                "VALUES (?,?,?,?,?,NULL)",
                (site, survey_date, rnd, memo, started_at),
            )
            self._conn.commit()
            sid = cur.lastrowid
        return {"id": sid, "site": site, "survey_date": survey_date, "round": rnd,
                "memo": memo, "started_at": started_at, "ended_at": None}

    def end_survey(self, survey_id, ended_at):
        with self._lock:
            self._conn.execute("UPDATE surveys SET ended_at=? WHERE id=? AND ended_at IS NULL",
                               (ended_at, survey_id))
            self._conn.commit()

    def survey_meta(self, survey_id):
        rows = self._q("SELECT * FROM surveys WHERE id=?", (survey_id,))
        return dict(rows[0]) if rows else None

    def surveys(self):
        """차수 목록 — 조사지·날짜·차수 + 레코드 통계."""
        rows = self._q(
            "SELECT s.id AS survey, s.site, s.survey_date, s.round, s.memo, "
            "       s.started_at, s.ended_at, "
            "       COUNT(r.ts) AS count, MIN(r.ts) AS start_ts, MAX(r.ts) AS end_ts, "
            "       COALESCE(SUM(r.status='fault'),0) AS fault, "
            "       COUNT(DISTINCT r.lat || ',' || r.lon) AS stations "
            "FROM surveys s LEFT JOIN records r ON r.survey = s.id "
            "GROUP BY s.id ORDER BY s.survey_date, s.site, s.round"
        )
        return [dict(r) for r in rows]

    def recent_sites(self, limit=12):
        """최근에 쓴 조사지 이름 — 헤더 입력란의 자동완성 목록."""
        rows = self._q(
            "SELECT site, MAX(started_at) AS last FROM surveys "
            "GROUP BY site ORDER BY last DESC LIMIT ?", (int(limit),)
        )
        return [r["site"] for r in rows]

    def records(self, survey, limit=None):
        sql = ("SELECT ts,survey,ec,tds,temp,depth,lat,lon,status,"
               "samples,ec_sd,tds_sd,temp_sd FROM records "
               "WHERE survey=? ORDER BY ts")
        args = [survey]
        if limit:
            sql += " LIMIT ?"
            args.append(int(limit))
        return [dict(r) for r in self._q(sql, tuple(args))]

    # ── 미러 (클라우드 전용) ─────────────────────────────────────────────
    # 아래 세 메서드는 **이미 라즈베리파이가 판정을 끝낸 값**을 그대로 넣는다.
    # 재계산·재판정 금지 (CLAUDE.md 0절).

    def max_ts(self):
        """저장된 측정 레코드의 최신 ts. 없으면 0 — forwarder 백필 기준점이다."""
        return int(self._q("SELECT MAX(ts) AS m FROM records")[0]["m"] or 0)

    def mirror_survey(self, row):
        """Pi 의 차수 행을 **id 까지 그대로** 복제한다.

        id 를 새로 매기면 레코드의 survey 참조가 어긋난다. 미러는 사본이지
        독립된 저장소가 아니다.
        """
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO surveys "
                "(id,site,survey_date,round,memo,started_at,ended_at) "
                "VALUES (?,?,?,?,?,?,?)",
                tuple(row.get(c) for c in SURVEY_COLUMNS),
            )
            self._conn.commit()

    def mirror_record(self, rec):
        """측정 레코드 1건을 즉시 넣는다. 이미 있으면 조용히 무시(백필 재전송 대비).

        같은 (survey, ts, depth) 는 같은 측정이다 — 한 층의 30초 측정이 끝날 때
        1건만 나오므로 이 셋이 겹치면 중복 전송이다. 배치 버퍼를 거치지 않는 이유는
        백필이 끝난 시점을 forwarder 에게 정확히 알려 줘야 하기 때문이다.
        """
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO records "
                "(ts,survey,ec,tds,temp,depth,lat,lon,status,samples,ec_sd,tds_sd,temp_sd) "
                "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? "
                "WHERE NOT EXISTS ("
                "  SELECT 1 FROM records WHERE survey=? AND ts=? AND depth=?)",
                tuple(rec.get(c) for c in COLUMNS)
                + (rec.get("survey"), rec.get("ts"), rec.get("depth")),
            )
            self._conn.commit()
            n = cur.rowcount or 0
            self.written += n
            return n

    def count(self, survey=None):
        if survey is None:
            return self._q("SELECT COUNT(*) AS c FROM records")[0]["c"]
        return self._q("SELECT COUNT(*) AS c FROM records WHERE survey=?", (survey,))[0]["c"]
