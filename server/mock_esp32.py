"""
mock_esp32.py — 실기 feed 대체 목업 센서 스트림 (1단계 mock-stream.js 이식).

이 모듈이 큐에 넣는 것은 **원시 스키마뿐**이다 (CLAUDE.md 1절).

    {"seq": 1024, "ec": 187.5, "tds": 93.0, "temp": 21.3}

수심 계산·GPS 병합·저장은 라즈베리파이(engine.py)의 몫이므로 여기서는 하지 않는다.
실기 feed 가 /ws/ingest 로 접속하면 engine 이 목업을 자동으로 멈추고
같은 큐로 들어오는 실측 표본을 그대로 쓴다(큐 인터페이스 동일).

센서값 생성 근거 — 세종 용암저수지 실측(2010~2026, 76건):
  EC 116~256 µS/cm, 수온 4.5~29.7 ℃. TDS 는 EC×0.5 환산 근사(CLAUDE.md 1절).
"""

import asyncio
import math
import random
import time

from config import (
    EC_OBSERVED, TDS_FACTOR, TEMP_OBSERVED,
    SITE_LAT, SITE_LON, SITE_SPAN_LAT, SITE_SPAN_LON,
    TICK_SECONDS,
)


def seasonal_surface_temp(now=None):
    """계절 기준 표층 수온. 실측 4.5~29.7℃ 를 1년 사인파로 근사(최저 1월 중순)."""
    t = time.localtime(now if now is not None else time.time())
    doy = t.tm_yday
    lo, hi = TEMP_OBSERVED
    mid = (hi + lo) / 2
    amp = (hi - lo) / 2
    return mid - amp * math.cos(2 * math.pi * (doy - 15) / 365)


def temp_at_depth(surface, depth):
    """수심에 따른 수온 감쇠 (표층 대비 얕은 성층)."""
    return surface - depth * 1.2


def base_ec(lat, lon, depth, rnd):
    """위치·수심 기반 EC. 실측 116~256 µS/cm 를 공간 구배 + 수심 구배로 재현."""
    nx = (lon - SITE_LON) / SITE_SPAN_LON      # -1..1
    ny = (lat - SITE_LAT) / SITE_SPAN_LAT
    lo, hi = EC_OBSERVED
    mid = (lo + hi) / 2
    spatial = (nx * 0.55 + ny * 0.42) * (hi - lo) * 0.5
    vertical = depth * 12                       # 깊을수록 약간 높음
    return mid + spatial + vertical + (rnd.random() - 0.5) * 8


def base_tds(ec, rnd):
    """TDS(ppm) ≈ EC × 0.5 ± 잡음. 실센서도 같은 팩터로 환산해 준다(1절).

    EC 가 NaN(fault 주입)이면 TDS 도 값이 없다 — 꾸며 내지 않는다.
    """
    if math.isnan(ec):
        return float("nan")
    return ec * TDS_FACTOR + (rnd.random() - 0.5) * 3.0


class MockESP32:
    """1 Hz 로 원시 표본을 큐에 넣는 가짜 수집기."""

    def __init__(self, engine, seed=None):
        self.engine = engine
        self.rnd = random.Random(seed)
        self.seq = 0
        self.surface_temp = seasonal_surface_temp()
        # Wi-Fi 끊김 재현: 이 구간에는 아무것도 보내지 않는다 → 라즈베리파이가 stale 판정
        self.silent_left = 0
        self.next_silent_in = 45 + self.rnd.randrange(40)

    def sample(self, lat, lon, depth):
        """프로브가 물리적으로 놓인 지점의 센서 원시값 1건."""
        rnd = self.rnd
        ec = base_ec(lat, lon, depth, rnd)
        temp = temp_at_depth(self.surface_temp, depth) + (rnd.random() - 0.5)

        # 가끔 주의 구간(>280), 드물게 위험 구간(>700) 삽입
        roll = rnd.random()
        if roll < 0.006:
            ec += 300 + rnd.random() * 200
        elif roll < 0.008:
            ec += 600 + rnd.random() * 400

        tds = base_tds(ec, rnd)      # EC 를 확정한 뒤 환산 (실센서와 같은 순서)

        # fault 주입 — NaN 또는 물리적으로 불가능한 범위 밖 값.
        # 수집기는 status 를 붙이지 않는다. 판정은 라즈베리파이가 한다(1절).
        froll = rnd.random()
        if froll < 0.006:
            if froll < 0.002:
                ec = float("nan")
            elif froll < 0.004:
                tds = 12500.0        # TDS 범위 밖 (fault 판정선 0~10000 ppm)
            else:
                temp = -20.1         # 수온 범위 밖

        self.seq += 1
        return {
            "seq": self.seq,
            "ec": ec if math.isnan(ec) else round(ec, 1),
            "tds": tds if math.isnan(tds) else round(tds, 1),
            "temp": temp if math.isnan(temp) else round(temp, 1),
        }

    async def run(self):
        """엔진과 같은 1 Hz 주기로 큐에 원시 표본을 공급한다."""
        next_t = time.monotonic()
        while True:
            next_t += TICK_SECONDS
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))

            if self.engine.ingest_clients:
                continue    # 실기 feed 가 붙어 있으면 목업은 침묵한다

            # 무송신 구간 주입 (CLAUDE.md 6절 stale 표시 검증용)
            if self.silent_left > 0:
                self.silent_left -= 1
                continue
            self.next_silent_in -= 1
            if self.next_silent_in <= 0:
                self.silent_left = 3 + self.rnd.randrange(3)   # 3~5초 무송신
                self.next_silent_in = 60 + self.rnd.randrange(60)
                continue

            lat, lon, depth = self.engine.probe_position()
            self.engine.push_raw(self.sample(lat, lon, depth))
