"""
engine.py — 라즈베리파이 본체 로직.

CLAUDE.md 0절이 라즈베리파이에 맡긴 일만 한다.
  · 윈치 상태기계(수심 추정)   SURFACE → DESCENDING → HOLD → ASCENDING → SURFACE
    자동 순환은 없다 (사용자 확정 2026-08-28). 측정 시작 → 0.5 m 측정 → 내림 → 1.0 m …
    → 측정 완료 → 부상. 각 층의 30초 측정이 끝나면 다음 명령이 올 때까지 대기한다.
  · 측정 레코드는 **한 수심 층에 1건**이다 (사용자 확정 2026-08-28).
    30초 표본을 모아 뒤 20초(SETTLE_SECONDS 이후)를 평균한 대표값 1건을 30초가 끝날 때 낸다.
    30초를 못 채우고 층을 옮기면 그 층은 기록하지 않는다.
  · GPS 병합
  · 두 채널 생성 (live 1 Hz 상시 / 측정 레코드는 HOLD 구간에서만)
  · SQLite 저장 위임, 대시보드 브로드캐스트

입력은 원시 표본 큐 {seq, ec, tds, temp} 하나뿐이다.
목업(mock_esp32)이든 실기 feed(raspi/feed.py → /ws/ingest)든 같은 큐로 들어온다.
"""

import asyncio
import json
import math
import random
import time

from config import (
    ALL_SENSORS, ASCENT_RATE, DEPTH_LEVELS, DESCENT_RATE, EC_FAULT_RANGE, HOLD_SECONDS,
    LEVEL_EPS, SENSORS, SETTLE_SECONDS, SITE_LAT, SITE_LON, SITE_SPAN_LAT, SITE_SPAN_LON,
    STALE_SECONDS, TDS_FAULT_RANGE, TEMP_FAULT_RANGE,
    TICK_SECONDS, TIME_SCALE,
)

SURFACE, DESCENDING, HOLD, ASCENDING = "SURFACE", "DESCENDING", "HOLD", "ASCENDING"
# 자동 순환(auto) 삭제, 측정 시작/완료 도입 (사용자 확정 2026-08-28).
#   measure_start : 수면에서 0.5 m 로 하강 → 자동 정지 → 30초 측정
#   down          : 30초 측정이 끝난 뒤 다음 층(1.0 → 1.5)으로만 진행
#   measure_end   : 현재 깊이에서 0 m 로 부상 (한 지점 1사이클 종료)
COMMANDS = ("down", "stop", "up", "measure_start", "measure_end",
            "survey_start", "survey_end")

MAX_DEPTH = DEPTH_LEVELS[-1]

# 항목별 fault 판정 범위 (CLAUDE.md 1절). 판정에 쓰는 항목은 SENSORS 로 제한된다.
FAULT_RANGES = {"ec": EC_FAULT_RANGE, "tds": TDS_FAULT_RANGE, "temp": TEMP_FAULT_RANGE}


def _clean(v):
    """NaN·None·비수치를 None 으로 정규화. JSON 에 NaN 을 실어 보내지 않는다."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def _in(v, rng):
    return v is not None and rng[0] <= v <= rng[1]


def _mean_sd(values):
    """평균과 표본표준편차. 값이 없으면 (None, None), 1개면 (값, None)."""
    n = len(values)
    if n == 0:
        return None, None
    m = sum(values) / n
    if n < 2:
        return round(m, 3), None
    var = sum((v - m) ** 2 for v in values) / (n - 1)
    return round(m, 3), round(math.sqrt(var), 3)


def snap_level(depth):
    """현재 수심이 측정 수심(0.5/1.0/1.5)인가 — 아니면 None(측정 레코드 생성 안 함)."""
    for lv in DEPTH_LEVELS:
        if abs(depth - lv) < LEVEL_EPS:
            return lv
    return None


class Engine:
    def __init__(self, store):
        self.store = store

        # 센서 → 라즈베리파이 원시 표본 큐 (목업/실기 공통 인터페이스)
        self.raw_q = asyncio.Queue(maxsize=64)
        self.ingest_clients = 0          # >0 이면 실제 ESP32 접속 중 → 목업 침묵
        self.last_raw = None
        self.last_raw_at = 0.0
        self.raw_count = 0

        # 윈치 상태기계 (CLAUDE.md 1절 — 라즈베리파이가 소유)
        self.state = SURFACE
        self.depth = 0.0
        self.measuring = False        # 측정 시작~완료 사이인가 (한 지점 1사이클)
        self.hold_elapsed = 0.0       # 이번 층에서의 측정 경과(초). HOLD_SECONDS 에서 멈춘다.
        self.hold_done = False        # 이번 층의 30초 측정이 끝나 레코드를 이미 냈는가
        self.hold_samples = []        # 이번 층의 표본 버퍼 [{t, ec, tds, temp, lat, lon}]
        self.target_idx = 0           # 이번에 내려갈 목표 층 (DEPTH_LEVELS 인덱스)

        # 보트 GPS (모의 — 실기에서는 GPS 모듈로 교체)
        self._rnd = random.Random(20260805)
        self.lat = SITE_LAT - SITE_SPAN_LAT * 0.6
        self.lon = SITE_LON - SITE_SPAN_LON * 0.6
        self.heading = math.pi * 0.35

        # 조사 차수 — **조작자가 "차수 시작"을 눌러야 생긴다** (사용자 확정 2026-08-29).
        # 전원만 켜져 있고 측정을 안 하면 차수도 레코드도 만들어지지 않는다.
        self.survey = None            # 열려 있는 차수 id (surveys.id)
        self.survey_active = False
        self.site = None              # 조사지(저수지) 이름
        self.round = None             # 그 조사지·그 날짜의 차수 번호
        self.survey_date = None

        self.clients = set()             # 대시보드 WebSocket
        self.live_sent = 0
        self.records_made = 0

    # ── ESP32 입력 ────────────────────────────────────────────────────────
    def push_raw(self, sample):
        """원시 표본 1건 투입. 큐가 넘치면 가장 오래된 것을 버린다(최신값 우선)."""
        if self.raw_q.full():
            try:
                self.raw_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self.raw_q.put_nowait(sample)
        except asyncio.QueueFull:
            pass

    def probe_position(self):
        """프로브가 지금 물리적으로 놓인 위치(목업 센서가 값을 만들 때 참조)."""
        return self.lat, self.lon, self.depth

    # ── 대시보드 클라이언트 ───────────────────────────────────────────────
    def add_client(self, ws):
        self.clients.add(ws)

    def remove_client(self, ws):
        self.clients.discard(ws)

    async def _broadcast(self, msg):
        if not self.clients:
            return
        payload = json.dumps(msg, allow_nan=False)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def _begin_hold(self):
        """새 층의 측정을 시작한다 — 경과·표본 버퍼를 비운다."""
        self.hold_elapsed = 0.0
        self.hold_done = False
        self.hold_samples = []

    def _abandon_hold(self):
        """30초를 못 채우고 층을 떠난다 — 모은 표본을 버린다(사용자 확정 2026-08-28)."""
        self.hold_elapsed = 0.0
        self.hold_done = False
        self.hold_samples = []

    # ── 명령 (대시보드 → 라즈베리파이) ────────────────────────────────────
    async def command(self, cmd, payload=None):
        """대시보드 명령. 자동 순환은 없다 — 층 이동은 항상 조작자가 누른다."""
        payload = payload or {}
        if cmd == "measure_start":
            # 차수가 열려 있지 않으면 측정을 시작하지 않는다 — 기록될 곳이 없다.
            if not self.survey_active:
                return False
            # 수면(또는 그 근처)에서만 시작한다. 0 → 0.5 m 하강 후 자동 정지.
            if self.depth <= LEVEL_EPS:
                self.measuring = True
                self.target_idx = 0
                self._abandon_hold()
                self.state = DESCENDING
        elif cmd == "measure_end":
            # 어느 층에 있든 0 m 로 부상. 사이클 종료(차수는 유지한다).
            self.measuring = False
            self._abandon_hold()
            self.state = ASCENDING if self.depth > 0 else SURFACE
        elif cmd == "down":
            # 다음 측정 층으로만 내려간다. 마지막 층이면 아무 것도 하지 않는다.
            nxt = next((i for i, lv in enumerate(DEPTH_LEVELS)
                        if lv > self.depth + LEVEL_EPS), None)
            if nxt is not None:
                self.target_idx = nxt
                self._abandon_hold()
                self.state = DESCENDING
        elif cmd == "stop":
            # 실제 윈치를 멈춘 순간의 동기화. 측정 층 위라면 그 자리에서 측정을 시작한다.
            self.state = SURFACE if self.depth <= 0 else HOLD
            self._begin_hold()
        elif cmd == "up":
            self.state = ASCENDING if self.depth > 0 else SURFACE
        elif cmd == "survey_start":
            # 조사지 이름이 있어야 차수를 연다. 차수 번호는 조사지+날짜 안에서만 올라간다
            # (저수지를 옮기면 다시 1차 — 사용자 확정 2026-08-29).
            site = (payload.get("site") or "").strip()
            if not site or self.survey_active:
                return False
            date = payload.get("date") or time.strftime("%Y-%m-%d", time.localtime())
            memo = (payload.get("memo") or "").strip() or None
            await self.store.flush()
            row = await asyncio.to_thread(
                self.store.create_survey, site, date, memo, int(time.time()))
            self.survey = row["id"]
            self.site = row["site"]
            self.round = row["round"]
            self.survey_date = row["survey_date"]
            self.survey_active = True
            print(f"[engine] 차수 시작: {site} {date} {row['round']}차 (id={row['id']})", flush=True)
        elif cmd == "survey_end":
            if not self.survey_active:
                return False
            # 진행 중이던 측정은 버린다 — 30초를 못 채운 층은 기록하지 않는다.
            self.measuring = False
            self._abandon_hold()
            if self.depth > 0:
                self.state = ASCENDING
            sid = self.survey
            self.survey_active = False
            await self.store.flush()
            await asyncio.to_thread(self.store.end_survey, sid, int(time.time()))
            print(f"[engine] 차수 종료: id={sid}", flush=True)
        else:
            return False
        return True

    # ── 1초 진행 ─────────────────────────────────────────────────────────
    def _move_boat(self, dt):
        """수면 대기 중일 때만 이동(프로브가 내려가 있으면 정지)."""
        if self.state != SURFACE:
            return
        rnd = self._rnd
        self.heading += (rnd.random() - 0.5) * 0.25
        # 조사 보트 이동 속도 약 1 m/s (위도 1도 ≈ 111 km)
        step = (0.0000082 + rnd.random() * 0.0000030) * dt
        n_lat = self.lat + math.cos(self.heading) * step
        n_lon = self.lon + math.sin(self.heading) * step * 1.25
        if abs(n_lat - SITE_LAT) > SITE_SPAN_LAT:      # 저수지 경계 반사
            self.heading = math.pi - self.heading
            n_lat = self.lat
        if abs(n_lon - SITE_LON) > SITE_SPAN_LON:
            self.heading = -self.heading
            n_lon = self.lon
        self.lat, self.lon = n_lat, n_lon

    def _step_winch(self, dt):
        """자동 순환 없음 — 층 이동은 measure_start / down / measure_end 로만 일어난다."""
        if self.state == SURFACE:
            self.depth = 0.0
            self.hold_elapsed = 0.0

        elif self.state == DESCENDING:
            self.depth += DESCENT_RATE * dt
            target = DEPTH_LEVELS[min(self.target_idx, len(DEPTH_LEVELS) - 1)]
            if self.depth >= target - 1e-9:
                # 목표 층 도달 → 자동 정지 후 30초 측정 시작 (사용자 확정 2026-08-28)
                self.depth = target
                self._begin_hold()
                self.state = HOLD
            if self.depth >= MAX_DEPTH:
                self.depth = MAX_DEPTH
                self._begin_hold()
                self.state = HOLD

        elif self.state == HOLD:
            # HOLD_SECONDS 에서 멈춘다. 자동으로 다음 층으로 넘어가지 않는다 —
            # 조작자가 '내림'(또는 '측정 완료')을 누를 때까지 완료 상태로 대기한다.
            if not self.hold_done:
                self.hold_elapsed = min(HOLD_SECONDS, self.hold_elapsed + dt)

        elif self.state == ASCENDING:
            self.depth -= ASCENT_RATE * dt
            if self.depth <= 0:
                self.depth = 0.0
                self.state = SURFACE
                self.measuring = False
                self._abandon_hold()

    def _drain_raw(self):
        """이번 틱에 도착한 원시 표본 중 최신 1건만 쓴다."""
        sample = None
        while True:
            try:
                sample = self.raw_q.get_nowait()
            except asyncio.QueueEmpty:
                break
            self.raw_count += 1
        if sample is not None:
            self.last_raw = sample
            self.last_raw_at = time.monotonic()
        return sample

    async def tick(self):
        dt = TICK_SECONDS * TIME_SCALE
        self._move_boat(dt)
        self._step_winch(dt)
        self._drain_raw()

        # ── status 판정 (CLAUDE.md 1절·6절) ──────────────────────────────
        age = time.monotonic() - self.last_raw_at
        raw = self.last_raw or {}
        # 미장착 항목(SENSORS 에 없는 것)은 값을 읽지 않고 항상 null 로 내보낸다.
        vals = {k: (_clean(raw.get(k)) if k in SENSORS else None) for k in ALL_SENSORS}
        ec, tds, temp = vals["ec"], vals["tds"], vals["temp"]

        if self.last_raw is None or age > STALE_SECONDS:
            # 2초 이상 미수신 — 마지막 값을 그대로 두되 stale 로 명시한다.
            status = "stale"
        elif not all(_in(vals[k], FAULT_RANGES[k]) for k in SENSORS):
            status = "fault"          # NaN·범위 밖 — 버리지 않고 저장한다(6절)
        else:
            status = "ok"

        depth = round(self.depth, 3)
        lat, lon = round(self.lat, 6), round(self.lon, 6)

        # ① live — 1 Hz 상시. 이동 중에도 나가며 저장하지 않는다.
        live = {
            "type": "live",
            "state": self.state,
            "depth_est": depth,
            # 측정 진행 상태 (CLAUDE.md 1절 확장, 사용자 확정 2026-08-28).
            # 대시보드가 live 수를 세어 추정하던 값을 서버 정본으로 바꾼 것이다 —
            # 재접속·시간 배속에도 진행 표시가 어긋나지 않는다.
            "measuring": self.measuring,
            "hold_elapsed": round(self.hold_elapsed, 1),
            "hold_total": HOLD_SECONDS,
            # 열려 있는 차수 — 대시보드가 즉시 알아야 버튼을 잠근다.
            # 차수를 닫으면 survey_open=false, survey=null 이 되고 site/round 는
            # 마지막 값이 남는다(헤더에 어디였는지 계속 보이게).
            "survey_open": self.survey_active,
            "survey": self.survey if self.survey_active else None,
            "site": self.site,
            "round": self.round if self.survey_active else None,
            "survey_date": self.survey_date,
            "ec": ec, "tds": tds, "temp": temp,
            "lat": lat, "lon": lon,
            "status": status,
        }
        await self._broadcast(live)
        self.live_sent += 1

        # ② 측정 레코드 — **한 수심 층에 1건** (사용자 확정 2026-08-28).
        #    HOLD 동안 표본만 모으고, 30초를 채우는 순간 대표값 1건을 낸다.
        #    stale(값 자체가 없음) 표본은 모으지 않는다 — 공백은 공백으로 둔다(6절).
        if self.state == HOLD and self.survey_active and not self.hold_done:
            level = snap_level(self.depth)
            if level is not None:
                if status != "stale":
                    self.hold_samples.append({
                        "t": self.hold_elapsed,
                        "ec": ec, "tds": tds, "temp": temp,
                        "lat": lat, "lon": lon,
                        "ok": status == "ok",
                    })
                if self.hold_elapsed >= HOLD_SECONDS:
                    rec = self._make_record(level)
                    self.hold_done = True
                    if rec is not None:
                        self.store.add(rec)          # 5초 배치 커밋 (3절)
                        self.records_made += 1
                        await self._broadcast(rec)
            else:
                # 측정 수심이 아니면 기록 대상이 아니다 — 완료 표시만 하고 넘어간다.
                if self.hold_elapsed >= HOLD_SECONDS:
                    self.hold_done = True

    def _make_record(self, level):
        """이번 층의 표본에서 대표값 레코드 1건을 만든다.

        도착 직후 SETTLE_SECONDS 는 버린다 — 프로브가 내려오면서 주변 물을 흔들어 놓아
        초반 값은 그 수심의 값이 아니다 (사용자 확정 2026-08-28: 30초 중 뒤 20초 평균).
        배속 시험(TIME_SCALE)처럼 틱이 성겨 정착 구간에 표본이 하나도 안 남으면
        전체 표본으로 물러선다 — 값을 못 내는 것보다 낫다.
        """
        ok = [x for x in self.hold_samples if x["ok"]]
        settled = [x for x in ok if x["t"] > SETTLE_SECONDS] or ok
        ts = int(time.time())

        if not settled:
            # 30초 내내 정상 표본이 하나도 없었다 — 값은 마지막 관측값을 원값 그대로 남기고
            # fault 로 표시한다 (버리지 않는다, CLAUDE.md 6절). 집계에서는 제외된다.
            last = self.hold_samples[-1] if self.hold_samples else None
            if last is None:
                return None                 # 표본이 아예 없음(전 구간 stale) → 공백으로 둔다
            return {
                "ts": ts, "survey": self.survey,
                "ec": last["ec"], "tds": last["tds"], "temp": last["temp"],
                "depth": level,
                "lat": last["lat"], "lon": last["lon"],
                "status": "fault",
                "samples": 0, "ec_sd": None, "tds_sd": None, "temp_sd": None,
            }

        vals = {k: [x[k] for x in settled if x[k] is not None] for k in ("ec", "tds", "temp")}
        stats = {k: _mean_sd(v) for k, v in vals.items()}
        lats = [x["lat"] for x in settled if x["lat"] is not None]
        lons = [x["lon"] for x in settled if x["lon"] is not None]

        return {
            "ts": ts, "survey": self.survey,
            "ec": stats["ec"][0], "tds": stats["tds"][0], "temp": stats["temp"][0],
            "depth": level,
            "lat": round(sum(lats) / len(lats), 6) if lats else None,
            "lon": round(sum(lons) / len(lons), 6) if lons else None,
            "status": "ok",
            "samples": len(settled),
            "ec_sd": stats["ec"][1], "tds_sd": stats["tds"][1], "temp_sd": stats["temp"][1],
        }

    async def run(self):
        # 기동 시 차수를 만들지 않는다 — 조작자가 "차수 시작"을 눌러야 생긴다.
        next_t = time.monotonic()
        while True:
            next_t += TICK_SECONDS
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))
            try:
                await self.tick()
            except Exception as exc:            # 틱 하나가 죽어도 루프는 계속
                print(f"[engine] tick error: {exc!r}", flush=True)
