"""
ects.py — EC/TDS 일체형 RS485 센서 리더 (Modbus-RTU).

CLAUDE.md 4절 사양 (사용자 제공 · 동작 확인된 소스코드 기준, 2026-08-10):
    /dev/ttyUSB0, 주소 5, 9600-8N1, timeout 1.0 s
    FC03(홀딩 레지스터), 값은 전부 uint16 정수
        reg0 = 수온 (원시값 ×0.1 ℃)   예) 213 → 21.3 ℃
        reg1 = EC   (µS/cm)
        reg4 = TDS  (ppm)

검증된 통신 관행 — 임의로 "개선"하지 말 것 (CLAUDE.md 4절 / 작업 지시):
    · clear_buffers_before_each_transaction = True
    · close_port_after_each_call = True   (호출마다 포트를 닫는다)
    · 레지스터 읽기 사이에 time.sleep(0.05)
    · reg0/reg1/reg4 를 **개별 read_register 3회**로 읽는다 (블록 읽기로 바꾸지 않는다)

스케일 변환은 순수 함수(scale_temp/scale_ec/scale_tds, decode_values)로 분리했다 —
하드웨어 없이 단위 테스트할 수 있는 부분은 여기까지다.
통신 실패는 여기서 삼키고 None 을 돌려준다(사유는 last_error). 재시도는 호출자 몫.

값 재보정 금지: 센서가 준 EC/TDS 를 그대로 전달한다 (CLAUDE.md 4절).
"""

import math
import time

# ── 레지스터 맵 (FC03 홀딩 레지스터, uint16) ───────────────────────────────
REG_TEMP = 0          # 수온 원시값 (×0.1 ℃)
REG_EC = 1            # EC (µS/cm)
REG_TDS = 4           # TDS (ppm)
REG_DUMP_COUNT = 10   # --probe 에서 훑어보는 범위 reg0~reg9

DEFAULT_PORT = "/dev/ttyUSB0"
DEFAULT_ADDR = 5
DEFAULT_BAUD = 9600
DEFAULT_TIMEOUT = 1.0     # 초 — 사용자 코드에서 검증된 값. 임의로 줄이지 않는다.
READ_GAP = 0.05           # 초 — 레지스터 읽기 사이 간격(검증된 관행)

TEMP_SCALE = 0.1          # reg0 원시값 → ℃


# ═══════════════════════════════════════════════════════════════════════════
# 순수 함수 (단위 테스트 대상 — 하드웨어 불필요)
# ═══════════════════════════════════════════════════════════════════════════

def scale_temp(raw):
    """수온 원시값(uint16) → ℃.  213 → 21.3

    센서는 부호 없는 정수를 준다. 영하 표기 규약은 확인되지 않았으므로
    변환하지 않는다(저수지 수질 조사 범위 0~35 ℃ 에서는 문제되지 않는다).
    """
    if raw is None:
        return None
    return round(float(raw) * TEMP_SCALE, 1)


def scale_ec(raw):
    """EC 원시값(uint16, µS/cm) → float. 스케일 없음 — 재보정 금지(4절)."""
    return None if raw is None else float(raw)


def scale_tds(raw):
    """TDS 원시값(uint16, ppm) → float. 센서가 계산한 값을 그대로 쓴다(1절)."""
    return None if raw is None else float(raw)


def decode_values(raw_temp, raw_ec, raw_tds):
    """원시 레지스터 3개 → 판독값 dict. 순수 함수(모의 장비 테스트에서 재사용)."""
    return {
        "ec": scale_ec(raw_ec),
        "tds": scale_tds(raw_tds),
        "temp": scale_temp(raw_temp),
    }


def plausible_ec(v):
    """물속 EC 로 말이 되는가 (증류수 ~1, 저수지 100~280, 해수 ~50000)."""
    return v is not None and 0.0 <= v <= 20000.0


def plausible_tds(v):
    """TDS 로 말이 되는가 (CLAUDE.md 1절 fault 판정선 0~10000 ppm)."""
    return v is not None and 0.0 <= v <= 10000.0


def plausible_temp(v):
    """수온으로 말이 되는가. 통신은 되는데 값이 이상한 경우를 잡는 용도."""
    return v is not None and -5.0 <= v <= 60.0


# ═══════════════════════════════════════════════════════════════════════════
# 센서
# ═══════════════════════════════════════════════════════════════════════════

class EcTds:
    """EC/TDS 일체형 센서 1대. minimalmodbus 인스턴스를 감싸기만 한다."""

    def __init__(self, port=DEFAULT_PORT, addr=DEFAULT_ADDR, baud=DEFAULT_BAUD,
                 timeout=DEFAULT_TIMEOUT):
        self.port, self.addr, self.baud = port, addr, baud
        self.timeout = timeout
        self.instrument = None
        self.last_error = None      # 현장 디버깅용 — 마지막 실패 사유

    def open(self):
        """포트 열기. 실패하면 예외를 그대로 올린다(기동 시점 오류는 보여야 한다)."""
        import minimalmodbus              # 지연 임포트 — 순수 함수 테스트는 없이도 돈다
        import serial

        inst = minimalmodbus.Instrument(self.port, self.addr,
                                        mode=minimalmodbus.MODE_RTU)
        inst.serial.baudrate = self.baud
        inst.serial.bytesize = 8
        inst.serial.parity = serial.PARITY_NONE
        inst.serial.stopbits = 1
        inst.serial.timeout = self.timeout
        # ── 검증된 관행 (사용자 제공 코드) — 바꾸지 말 것 ──
        inst.clear_buffers_before_each_transaction = True
        inst.close_port_after_each_call = True
        self.instrument = inst
        return self

    def close(self):
        try:
            if self.instrument is not None:
                self.instrument.serial.close()
        except Exception:
            pass

    # ── 원시 읽기 ──────────────────────────────────────────────────────────
    def read_register(self, reg):
        """홀딩 레지스터 1개(FC03, uint16). 실패 시 None."""
        if self.instrument is None:
            self.open()
        try:
            return self.instrument.read_register(reg, 0, functioncode=3)
        except Exception as exc:          # 타임아웃·CRC·프레임 오류 전부
            self.last_error = f"reg{reg}: {type(exc).__name__}: {exc}"
            return None

    def read_dump(self, count=REG_DUMP_COUNT):
        """reg0~reg(count-1) 을 하나씩 읽어 리스트로. 실패한 자리는 None.

        --probe 전용이다. 여기서도 블록 읽기를 쓰지 않는다(검증된 관행 유지).
        """
        out = []
        for reg in range(count):
            out.append(self.read_register(reg))
            time.sleep(READ_GAP)
        return out

    # ── 가공 읽기 ──────────────────────────────────────────────────────────
    def read(self):
        """{"ec": float|None, "tds": float|None, "temp": float|None} 또는 None.

        reg0 → reg1 → reg4 를 개별 read_register 3회로 읽고 사이에 50 ms 를 둔다.
        셋 다 실패하면 None 을 돌려준다 → 호출자(feed.py)가 그 틱을 건너뛰고
        서버가 2초 뒤 status="stale" 로 표시한다 (CLAUDE.md 6절).
        일부만 실패하면 그 항목만 None 으로 보낸다(값을 꾸며 내지 않는다).
        """
        raw_temp = self.read_register(REG_TEMP)
        time.sleep(READ_GAP)
        raw_ec = self.read_register(REG_EC)
        time.sleep(READ_GAP)
        raw_tds = self.read_register(REG_TDS)

        if raw_temp is None and raw_ec is None and raw_tds is None:
            return None
        return decode_values(raw_temp, raw_ec, raw_tds)


def finite(v):
    """NaN·inf 는 값이 없는 것으로 본다 (JSON 에 NaN 금지 — CLAUDE.md 1절)."""
    if v is None:
        return None
    f = float(v)
    return None if (math.isnan(f) or math.isinf(f)) else f
