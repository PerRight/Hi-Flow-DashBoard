"""
dec890.py — Daruifuno DEC890 EC 센서 리더 (RS485 Modbus-RTU).

CLAUDE.md 4절 사양:
    주소 17, 9600-8N1, FC04(입력 레지스터)
    reg0 = Status(uint16, 0 이 아니면 교정 중)
    reg2 = EC (float, µS/cm)
    reg4 = 수온 (float, ℃)
    reg6 = 염분(ppt), reg8 = TDS(ppm)   ← 이 프로젝트에서는 쓰지 않는다(진단용)

float 2워드의 배열 순서는 장비마다 다르다. 매뉴얼은 little-endian byte-swap
(= CDAB, 워드 스왑)이라고 하지만 현장 개체가 다른 경우가 흔하므로
`feed.py --probe` 로 4가지를 모두 찍어 보고 --order 로 고를 수 있게 해 둔다.

바이트 해석은 순수 함수(decode_float/encode_float)로 분리 — 단위 테스트 대상.
통신 실패·CRC 오류는 여기서 삼키고 None 을 돌려준다. 재시도는 호출자 몫.
"""

import math
import struct

# ── 레지스터 맵 (FC04) ─────────────────────────────────────────────────────
REG_STATUS = 0        # uint16 — 0 이 아니면 교정 중
REG_EC = 2            # float  — µS/cm
REG_TEMP = 4          # float  — ℃
REG_SALINITY = 6      # float  — ppt
REG_TDS = 8           # float  — ppm
REG_COUNT = 10        # 0~9 를 한 번에 읽는다 (한 트랜잭션 = 버스 부하 최소)

DEFAULT_PORT = "/dev/ttyUSB0"
DEFAULT_ADDR = 17
DEFAULT_BAUD = 9600
DEFAULT_TIMEOUT = 0.4     # 초 — 1초 폴링 주기를 넘기지 않도록 0.5 이하 (CLAUDE.md 제약)

# ── 워드/바이트 순서 ───────────────────────────────────────────────────────
# 워드 2개(w0, w1)의 바이트를 a,b,c,d 로 두고( w0 = ab, w1 = cd ),
# IEEE-754 big-endian 바이트열을 만들 때 어느 자리에서 가져올지의 순열.
#   big         ABCD  대부분의 서구권 장비
#   big-swap    BADC  워드 내부만 뒤집힘
#   little      DCBA  완전 역순
#   little-swap CDAB  워드끼리만 교환 — 중국제 RS485 센서에서 가장 흔함(매뉴얼 기재값)
WORD_ORDERS = {
    "big":         (0, 1, 2, 3),
    "big-swap":    (1, 0, 3, 2),
    "little":      (3, 2, 1, 0),
    "little-swap": (2, 3, 0, 1),
}
ORDER_LABELS = {
    "big": "ABCD", "big-swap": "BADC", "little": "DCBA", "little-swap": "CDAB",
}
DEFAULT_ORDER = "little-swap"     # 매뉴얼 기재: little endian byte-swap


def decode_float(w0, w1, order=DEFAULT_ORDER):
    """레지스터 워드 2개 → float. 순수 함수."""
    perm = WORD_ORDERS[order]
    wb = ((w0 >> 8) & 0xFF, w0 & 0xFF, (w1 >> 8) & 0xFF, w1 & 0xFF)
    return struct.unpack(">f", bytes(wb[p] for p in perm))[0]


def encode_float(value, order=DEFAULT_ORDER):
    """float → 레지스터 워드 2개. decode_float 의 역함수(테스트·모의 장비용)."""
    perm = WORD_ORDERS[order]
    packed = struct.pack(">f", value)
    wb = [0, 0, 0, 0]
    for i, p in enumerate(perm):
        wb[p] = packed[i]
    return (wb[0] << 8) | wb[1], (wb[2] << 8) | wb[3]


def _finite(v):
    """NaN·inf 는 값이 없는 것으로 본다 (JSON 에 NaN 금지 — CLAUDE.md 1절)."""
    if v is None:
        return None
    f = float(v)
    return None if (math.isnan(f) or math.isinf(f)) else f


def plausible_ec(v):
    """물속 EC 로 말이 되는 값인가 (증류수 ~1, 저수지 100~280, 해수 ~50000)."""
    return v is not None and 0.0 <= v <= 20000.0


def plausible_temp(v):
    """수온으로 말이 되는 값인가.

    워드 순서를 잘못 맞추면 1e-13 같은 비정규화 수가 나오는데, 범위만 보면
    '0℃ 근처'로 통과해 버린다. 그래서 아주 작은 절댓값은 쓰레기로 본다.
    """
    return v is not None and -5.0 <= v <= 60.0 and abs(v) >= 1e-3


class Dec890:
    """센서 1대. minimalmodbus 인스턴스를 감싸기만 한다."""

    def __init__(self, port=DEFAULT_PORT, addr=DEFAULT_ADDR, baud=DEFAULT_BAUD,
                 timeout=DEFAULT_TIMEOUT, order=DEFAULT_ORDER):
        if order not in WORD_ORDERS:
            raise ValueError(f"order 는 {list(WORD_ORDERS)} 중 하나")
        self.port, self.addr, self.baud = port, addr, baud
        self.timeout, self.order = timeout, order
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
        inst.clear_buffers_before_each_transaction = True
        inst.close_port_after_each_call = False
        self.instrument = inst
        return self

    def close(self):
        try:
            if self.instrument is not None:
                self.instrument.serial.close()
        except Exception:
            pass

    # ── 원시 읽기 ──────────────────────────────────────────────────────────
    def read_raw(self, count=REG_COUNT):
        """FC04 로 reg0~reg(count-1) 을 읽어 워드 리스트 반환. 실패 시 None."""
        if self.instrument is None:
            self.open()
        try:
            return self.instrument.read_registers(0, count, functioncode=4)
        except Exception as exc:          # 타임아웃·CRC·프레임 오류 전부
            self.last_error = f"{type(exc).__name__}: {exc}"
            return None

    # ── 가공 읽기 ──────────────────────────────────────────────────────────
    def read(self):
        """{"ec": float|None, "temp": float|None, "calibrating": bool} 또는 None."""
        regs = self.read_raw()
        if regs is None:
            return None
        return decode_registers(regs, self.order)


def decode_registers(regs, order=DEFAULT_ORDER):
    """워드 리스트 → 센서 판독값. 순수 함수(모의 장비 테스트에서 그대로 재사용)."""
    ec = _finite(decode_float(regs[REG_EC], regs[REG_EC + 1], order))
    temp = _finite(decode_float(regs[REG_TEMP], regs[REG_TEMP + 1], order))
    return {
        "ec": ec,
        "temp": temp,
        "calibrating": bool(regs[REG_STATUS]),
    }
