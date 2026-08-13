"""
feed.py — EC/TDS 일체형 센서를 라즈베리파이에서 직접 읽어 서버 /ws/ingest 로 공급.

CLAUDE.md 1절 원시 스키마만 보낸다. 키 추가 금지.

    {"seq": 1024, "ec": 187.5, "tds": 93.0, "temp": 21.3}

pH 는 센서 구성에서 제외됐다(2026-08-10). `tds` 는 센서가 계산해 준 값을 그대로
전달한다 — 재계산·재보정 금지 (CLAUDE.md 1·4절).
읽기 실패한 틱은 아예 보내지 않는다 → 서버가 2초 후 status="stale" 로 표시(6절).

사용법
    python3 feed.py --port /dev/ttyUSB0 --server ws://localhost:8000/ws/ingest
    python3 feed.py --probe        # 서버 없이 센서만: reg0~9 덤프 + 스케일 해석표
    python3 feed.py --once         # 서버 없이 1회 읽어 사람이 보기 좋게 출력
    python3 feed.py --fake         # 센서 없이 가짜 값 송신 (시험 전용)

레거시: 구형 DEC890 을 붙일 때만 --driver dec890 (참고용으로 남겨 둔 경로).
"""

import argparse
import asyncio
import json
import math
import sys
import time

import ects
from ects import EcTds, REG_DUMP_COUNT, REG_EC, REG_TDS, REG_TEMP

DEFAULT_SERVER = "ws://localhost:8000/ws/ingest"
BACKOFF_START = 0.5
BACKOFF_MAX = 10.0        # 지수 백오프 상한 (CLAUDE.md 4절)


def ts():
    return time.strftime("%H:%M:%S")


def log(msg):
    print(f"[{ts()}] {msg}", flush=True)


# ═══════════════════════════════════════════════════════════════════════════
# 가짜 센서 (시험 전용 — 하드웨어 없이 서버 왕복을 검증할 때만)
# ═══════════════════════════════════════════════════════════════════════════

class FakeSensor:
    """ects.EcTds 와 같은 인터페이스. read_dump/read 만 흉내낸다."""

    def __init__(self):
        self.n = 0
        self.last_error = None

    def open(self):
        return self

    def close(self):
        pass

    def _raw(self):
        raw_temp = 213 + (self.n % 5)               # 21.3~21.7 ℃
        raw_ec = 187 + (self.n % 10)               # 187~196 µS/cm
        raw_tds = int(round(raw_ec * 0.5))         # 센서 TDS 팩터 0.5 가정
        return raw_temp, raw_ec, raw_tds

    def read_dump(self, count=REG_DUMP_COUNT):
        raw_temp, raw_ec, raw_tds = self._raw()
        regs = [0] * count
        regs[REG_TEMP], regs[REG_EC], regs[REG_TDS] = raw_temp, raw_ec, raw_tds
        return regs

    def read(self):
        self.n += 1
        return ects.decode_values(*self._raw())


# ═══════════════════════════════════════════════════════════════════════════
# 디버그 모드
# ═══════════════════════════════════════════════════════════════════════════

def _pad(s, width):
    """한글은 터미널에서 2칸을 먹으므로 표시 폭 기준으로 채운다(표 정렬용)."""
    import unicodedata
    w = sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)
    return s + " " * max(0, width - w)


def _num(v, fmt="{:.1f}"):
    return "—" if v is None else fmt.format(v)


def probe(sensor):
    """FC03 reg0~reg9 원시 덤프 + 스케일 해석표.

    현장에서 "통신은 되는데 값이 이상하다" 를 5초 안에 판단하기 위한 화면이다.
    레지스터는 하나씩 읽는다(검증된 관행 — 블록 읽기로 바꾸지 않는다).
    """
    regs = sensor.read_dump()
    if all(r is None for r in regs):
        log(f"읽기 실패: {sensor.last_error}")
        log("→ 타임아웃이면 A/B 선 반전·주소(5)·보레이트(9600)를 먼저 의심하세요 (README).")
        return 1

    print()
    print("── 원시 레지스터 (FC03 홀딩, reg0~reg9, uint16) ──────────────────")
    for i, w in enumerate(regs):
        if w is None:
            print(f"  reg{i:<2d}  {'읽기 실패':>12}")
        else:
            print(f"  reg{i:<2d}  0x{w:04X}  {w:>6d}")

    print("\n── 스케일 해석 (CLAUDE.md 4절 레지스터 맵) ───────────────────────")
    print("  " + _pad("레지스터", 12) + _pad("원시값", 10) + _pad("해석", 24) + "판정")
    rows = [
        ("reg0 수온", REG_TEMP, lambda r: f"{ects.scale_temp(r):.1f} ℃  (원시 ÷10)",
         ects.plausible_temp, ects.scale_temp),
        ("reg1 EC", REG_EC, lambda r: f"{ects.scale_ec(r):.1f} µS/cm  (스케일 없음)",
         ects.plausible_ec, ects.scale_ec),
        ("reg4 TDS", REG_TDS, lambda r: f"{ects.scale_tds(r):.1f} ppm  (스케일 없음)",
         ects.plausible_tds, ects.scale_tds),
    ]
    for label, reg, render, ok_fn, scale_fn in rows:
        raw = regs[reg]
        if raw is None:
            print("  " + _pad(label, 12) + _pad("—", 10) + _pad("읽기 실패", 16) + "??")
            continue
        ok = ok_fn(scale_fn(raw))
        print("  " + _pad(label, 12) + _pad(str(raw), 10)
              + _pad(render(raw), 24) + ("ok" if ok else "?? 값이 이상합니다"))

    print("\n  · 수온이 지금 수온/기온과 비슷하면 통신·스케일이 맞는 것입니다.")
    print("  · 프로브가 공기 중이면 EC·TDS ≈ 0 이 정상 — 판정은 수온을 먼저 보세요.")
    print("  · reg2·3·5~9 는 이 프로젝트에서 쓰지 않습니다(벤더 미공개, 참고용 덤프).")
    print("  · EC 정확도는 1413 µS/cm 표준액 대조 검증(±5%)으로 확인합니다 (4절).")
    print()
    return 0


def once(sensor):
    """1회 읽고 사람이 보기 좋게 출력."""
    r = sensor.read()
    if r is None:
        log(f"읽기 실패: {sensor.last_error}")
        return 1
    ec, tds, temp = r["ec"], r["tds"], r["temp"]
    print()
    print(f"  EC   : {_num(ec)} µS/cm"
          f"{'' if ects.plausible_ec(ec) else '   ← 값이 이상합니다. --probe 로 확인'}")
    print(f"  TDS  : {_num(tds)} ppm"
          f"{'' if ects.plausible_tds(tds) else '   ← 값이 이상합니다. --probe 로 확인'}")
    print(f"  수온 : {_num(temp)} ℃"
          f"{'' if ects.plausible_temp(temp) else '   ← 값이 이상합니다. --probe 로 확인'}")
    if sensor.last_error:
        print(f"  (마지막 오류: {sensor.last_error})")
    print()
    return 0


# ═══════════════════════════════════════════════════════════════════════════
# 송신 루프
# ═══════════════════════════════════════════════════════════════════════════

def _r2(v):
    """소수 둘째 자리 반올림. 표현 잡음만 자른다 — 값 재보정이 아니다(4절)."""
    v = ects.finite(v)
    return None if v is None else round(v, 2)


async def feed(sensor, url, interval, verbose=True):
    import websockets

    seq = 0
    fails = 0
    backoff = BACKOFF_START
    loop = asyncio.get_running_loop()

    while True:
        try:
            log(f"연결 시도 {url}")
            async with websockets.connect(url, open_timeout=5,
                                          ping_interval=20) as ws:
                log("연결됨 — 1 Hz 송신 시작")
                backoff = BACKOFF_START
                next_t = loop.time()
                while True:
                    next_t += interval
                    await asyncio.sleep(max(0.0, next_t - loop.time()))

                    r = await asyncio.to_thread(sensor.read)
                    if r is None:
                        fails += 1
                        # 이 틱은 보내지 않는다 → 서버가 2초 뒤 stale 표시 (6절)
                        log(f"센서 읽기 실패({fails}회째) — 송신 생략: "
                            f"{sensor.last_error}")
                        continue

                    seq += 1
                    # CLAUDE.md 1절 원시 스키마 4키. 추가·개명 금지.
                    msg = {"seq": seq,
                           "ec": _r2(r.get("ec")),
                           "tds": _r2(r.get("tds")),
                           "temp": _r2(r.get("temp"))}
                    await ws.send(json.dumps(msg, allow_nan=False))

                    if verbose:
                        flags = []
                        if not ects.plausible_ec(r.get("ec")):
                            flags.append("EC이상")
                        if not ects.plausible_tds(r.get("tds")):
                            flags.append("TDS이상")
                        if not ects.plausible_temp(r.get("temp")):
                            flags.append("수온이상")
                        log(f"seq={seq:<6d} ec={_num(r.get('ec')):>8} µS/cm  "
                            f"tds={_num(r.get('tds')):>8} ppm  "
                            f"temp={_num(r.get('temp')):>6} ℃"
                            + ("  [" + ",".join(flags) + "]" if flags else ""))

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log(f"WebSocket 끊김/실패: {type(exc).__name__}: {exc} "
                f"→ {backoff:.1f}초 후 재연결")
            await asyncio.sleep(backoff)
            backoff = min(BACKOFF_MAX, backoff * 2)      # 지수 백오프, 상한 10초


# ═══════════════════════════════════════════════════════════════════════════
# 레거시 드라이버 (DEC890) — 참고용. 실장착 센서가 아니다.
# ═══════════════════════════════════════════════════════════════════════════

def _legacy_probe(sensor):
    """DEC890 전용 워드 순서 판별표 (dec890.py 사양)."""
    import dec890
    from dec890 import ORDER_LABELS, WORD_ORDERS, decode_float

    regs = sensor.read_raw()
    if regs is None:
        log(f"읽기 실패: {sensor.last_error}")
        return 1
    print()
    print("── [레거시 DEC890] 원시 레지스터 (FC04, reg0~reg9) ───────────────")
    for i, w in enumerate(regs):
        print(f"  reg{i:<2d}  0x{w:04X}  {w:>6d}")
    print(f"\n  Status(reg0) = {regs[0]}  → {'교정 중!' if regs[0] else '정상'}")
    print("\n── float 해석 (워드/바이트 순서 4종) ────────────────────────────")
    for label, base in [("EC   (reg2·3, µS/cm)", 2), ("수온 (reg4·5, ℃)", 4),
                        ("염분 (reg6·7, ppt)", 6), ("TDS  (reg8·9, ppm)", 8)]:
        row = "  " + _pad(label, 22)
        for o in WORD_ORDERS:
            v = decode_float(regs[base], regs[base + 1], o)
            row += (f"{v!r:>16}" if (v is None or math.isnan(v) or math.isinf(v))
                    else f"{v:>16.3f}") + "  "
        print(row + f"   ({'/'.join(ORDER_LABELS[o] for o in WORD_ORDERS)})")
    print()
    for o in WORD_ORDERS:
        ec = decode_float(regs[2], regs[3], o)
        tp = decode_float(regs[4], regs[5], o)
        mark = "✓" if (dec890.plausible_ec(ec) and dec890.plausible_temp(tp)) else " "
        print(f"   {mark} --order {o:<12} EC={ec:>14.3f}  temp={tp:>14.3f}")
    print()
    return 0


def _legacy_once(sensor, order):
    r = sensor.read()
    if r is None:
        log(f"읽기 실패: {sensor.last_error}")
        return 1
    print()
    print(f"  [레거시 DEC890] 워드 순서 : {order}")
    print(f"  EC   : {_num(r['ec'])} µS/cm")
    print(f"  수온 : {_num(r['temp'])} ℃")
    print(f"  교정 상태 : {'교정 중 (측정값 신뢰 불가)' if r['calibrating'] else '정상'}")
    print("  (DEC890 은 TDS 를 이 경로로 읽지 않는다 → 서버에 null 로 송신)")
    print()
    return 0


# ═══════════════════════════════════════════════════════════════════════════

def main(argv=None):
    p = argparse.ArgumentParser(
        description="EC/TDS 일체형 RS485 센서 → 서버 /ws/ingest 공급기",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--driver", default="ects", choices=("ects", "dec890"),
                   help="센서 드라이버. ects=실장착 EC/TDS 일체형, "
                        "dec890=레거시(참고용, 주소 17·FC04·float)")
    p.add_argument("--port", default=ects.DEFAULT_PORT,
                   help="시리얼 포트 (USB-RS485: /dev/ttyUSB0, GPIO UART: /dev/serial0)")
    p.add_argument("--server", default=DEFAULT_SERVER, help="서버 WebSocket URL")
    p.add_argument("--addr", type=int, default=None,
                   help="Modbus 슬레이브 주소 (기본: ects=5, dec890=17)")
    p.add_argument("--baud", type=int, default=ects.DEFAULT_BAUD, help="보레이트")
    p.add_argument("--interval", type=float, default=1.0, help="폴링 주기(초)")
    p.add_argument("--timeout", type=float, default=None,
                   help="Modbus 응답 대기(초, 기본: ects=1.0, dec890=0.4)")
    p.add_argument("--order", default=None,
                   help="[--driver dec890 전용] float 워드/바이트 순서 "
                        "(big|big-swap|little|little-swap)")
    p.add_argument("--probe", action="store_true",
                   help="서버 없이 레지스터 덤프 + 스케일 해석표 출력 후 종료")
    p.add_argument("--once", action="store_true",
                   help="서버 없이 1회 읽어 출력 후 종료")
    p.add_argument("--fake", action="store_true",
                   help="센서 없이 가짜 값 사용 (시험 전용, 하드웨어 불필요)")
    p.add_argument("--quiet", action="store_true", help="틱마다 값 출력 안 함")
    args = p.parse_args(argv)

    legacy = args.driver == "dec890"
    if args.order is not None and not legacy:
        log("경고: --order 는 --driver dec890 전용입니다. 무시합니다 "
            "(실장착 EC/TDS 센서는 uint16 이라 워드 순서 개념이 없습니다).")

    order = None
    if legacy:
        import dec890
        order = args.order or dec890.DEFAULT_ORDER
        if order not in dec890.WORD_ORDERS:
            log(f"--order 는 {list(dec890.WORD_ORDERS)} 중 하나여야 합니다.")
            return 2
        addr = args.addr if args.addr is not None else dec890.DEFAULT_ADDR
        timeout = args.timeout if args.timeout is not None else dec890.DEFAULT_TIMEOUT
    else:
        addr = args.addr if args.addr is not None else ects.DEFAULT_ADDR
        timeout = args.timeout if args.timeout is not None else ects.DEFAULT_TIMEOUT

    streaming = not (args.probe or args.once)      # 송신 루프에서만 의미 있는 경고
    if streaming and not legacy and timeout * 3 > args.interval:
        log(f"참고: 레지스터 3회 읽기 × timeout {timeout}s — 통신이 전부 실패하면 "
            f"한 틱이 폴링 주기({args.interval}s)를 넘길 수 있습니다(정상 통신 시 무관).")

    if args.fake:
        if legacy:
            log("--fake 는 실장착 센서(ects) 기준으로만 제공합니다.")
            return 2
        sensor = FakeSensor()
        log("가짜 센서 모드 (시험 전용)")
    elif legacy:
        from dec890 import Dec890
        sensor = Dec890(port=args.port, addr=addr, baud=args.baud,
                        timeout=timeout, order=order)
        try:
            sensor.open()
        except Exception as exc:
            log(f"포트 열기 실패 {args.port}: {type(exc).__name__}: {exc}")
            return 2
        log(f"[레거시 DEC890] 포트 {args.port} @ {args.baud}-8N1 주소 {addr} "
            f"timeout {timeout}s order {order}")
    else:
        sensor = EcTds(port=args.port, addr=addr, baud=args.baud, timeout=timeout)
        try:
            sensor.open()
        except Exception as exc:
            log(f"포트 열기 실패 {args.port}: {type(exc).__name__}: {exc}")
            log("→ 장치 확인: ls -l /dev/ttyUSB* /dev/serial0 · 권한(dialout) · README 참조")
            return 2
        log(f"포트 {args.port} @ {args.baud}-8N1 주소 {addr} timeout {timeout}s "
            f"(FC03 reg0=수온·reg1=EC·reg4=TDS)")

    try:
        if args.probe:
            return _legacy_probe(sensor) if (legacy and not args.fake) else probe(sensor)
        if args.once:
            return _legacy_once(sensor, order) if (legacy and not args.fake) else once(sensor)
        return asyncio.run(feed(sensor, args.server, args.interval,
                                verbose=not args.quiet))
    except KeyboardInterrupt:
        log("중단됨")
        return 0
    finally:
        sensor.close()


if __name__ == "__main__":
    sys.exit(main())
