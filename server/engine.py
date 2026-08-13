"""
engine.py — 라즈베리파이 본체 로직.

CLAUDE.md 0절이 라즈베리파이에 맡긴 일만 한다.
  · 윈치 상태기계(수심 추정)   SURFACE → DESCENDING → HOLD → ASCENDING → SURFACE
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
    LEVEL_EPS, SENSORS, SITE_LAT, SITE_LON, SITE_SPAN_LAT, SITE_SPAN_LON,
    STALE_SECONDS, SURFACE_WAIT_SECONDS, TDS_FAULT_RANGE, TEMP_FAULT_RANGE,
    TICK_SECONDS, TIME_SCALE,
)

SURFACE, DESCENDING, HOLD, ASCENDING = "SURFACE", "DESCENDING", "HOLD", "ASCENDING"
COMMANDS = ("down", "stop", "up", "auto", "survey_start", "survey_end")

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
        self.auto = True
        self.hold_elapsed = 0.0
        self.target_idx = 0
        self.surface_wait = 0.0

        # 보트 GPS (모의 — 실기에서는 GPS 모듈로 교체)
        self._rnd = random.Random(20260805)
        self.lat = SITE_LAT - SITE_SPAN_LAT * 0.6
        self.lon = SITE_LON - SITE_SPAN_LON * 0.6
        self.heading = math.pi * 0.35

        # 조사 차수
        self.survey = 1
        self.survey_active = True

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

    # ── 명령 (대시보드 → 라즈베리파이) ────────────────────────────────────
    async def command(self, cmd):
        if cmd == "down":
            self.auto = False
            if self.depth < MAX_DEPTH:
                self.state = DESCENDING
        elif cmd == "stop":
            self.auto = False
            self.state = SURFACE if self.depth <= 0 else HOLD
            self.hold_elapsed = 0.0
        elif cmd == "up":
            self.auto = False
            self.state = ASCENDING if self.depth > 0 else SURFACE
        elif cmd == "auto":
            # 0.5 → 1.0 → 1.5 순차 측정 후 부상 (CLAUDE.md 0절)
            self.auto = True
            self.target_idx = next(
                (i for i, lv in enumerate(DEPTH_LEVELS) if lv > self.depth + 1e-9), 0)
        elif cmd == "survey_start":
            await self.store.flush()
            self.survey = await asyncio.to_thread(self.store.next_survey)
            self.survey_active = True
        elif cmd == "survey_end":
            self.survey_active = False
            await self.store.flush()
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
        if self.state == SURFACE:
            self.depth = 0.0
            if self.auto:
                self.surface_wait += dt
                if self.surface_wait >= SURFACE_WAIT_SECONDS:
                    self.surface_wait = 0.0
                    self.target_idx = 0
                    self.state = DESCENDING

        elif self.state == DESCENDING:
            self.depth += DESCENT_RATE * dt
            if self.auto and self.target_idx < len(DEPTH_LEVELS):
                target = DEPTH_LEVELS[self.target_idx]
                if self.depth >= target - 1e-9:
                    self.depth = target
                    self.hold_elapsed = 0.0
                    self.state = HOLD
            if self.depth >= MAX_DEPTH:      # 수동 모드라도 최심부에서는 정지
                self.depth = MAX_DEPTH
                self.hold_elapsed = 0.0
                self.state = HOLD

        elif self.state == HOLD:
            self.hold_elapsed += dt
            if self.auto and self.hold_elapsed >= HOLD_SECONDS:
                self.hold_elapsed = 0.0
                self.target_idx += 1
                if self.target_idx < len(DEPTH_LEVELS):
                    self.state = DESCENDING
                else:
                    self.target_idx = 0
                    self.state = ASCENDING

        elif self.state == ASCENDING:
            self.depth -= ASCENT_RATE * dt
            if self.depth <= 0:
                self.depth = 0.0
                self.state = SURFACE
                self.surface_wait = 0.0

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
            "ec": ec, "tds": tds, "temp": temp,
            "lat": lat, "lon": lon,
            "status": status,
        }
        await self._broadcast(live)
        self.live_sent += 1

        # ② 측정 레코드 — HOLD 이고 측정 수심(0.5/1.0/1.5)일 때만.
        #    stale(값 자체가 없음) 구간에서는 만들지 않는다 — 공백은 공백으로 둔다.
        if self.state == HOLD and self.survey_active and status != "stale":
            level = snap_level(self.depth)
            if level is not None:
                rec = {
                    "ts": int(time.time()),
                    "survey": self.survey,
                    "ec": ec, "tds": tds, "temp": temp,
                    "depth": level,
                    "lat": lat, "lon": lon,
                    "status": status,
                }
                self.store.add(rec)          # 5초 배치 커밋 (3절)
                self.records_made += 1
                await self._broadcast(rec)

    async def run(self):
        self.survey = await asyncio.to_thread(self.store.next_survey)
        next_t = time.monotonic()
        while True:
            next_t += TICK_SECONDS
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))
            try:
                await self.tick()
            except Exception as exc:            # 틱 하나가 죽어도 루프는 계속
                print(f"[engine] tick error: {exc!r}", flush=True)
