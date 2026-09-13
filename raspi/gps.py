"""
gps.py — 부표(보트) GPS NMEA 리더. feed.py 가 1 Hz 송신에 좌표를 실을 때 쓴다.

CLAUDE.md 0절 역할 경계를 지킨다: 수집기는 **읽어서 보내기만** 한다.
좌표를 만들거나 보정하지 않고, 수신한 FIX 를 그대로 넘긴다.

GPS 는 1 Hz 송신 주기와 무관하게 NMEA 문장을 연속으로 흘려보내므로 별도 스레드에서
계속 읽어야 한다(버퍼가 밀리면 좌표가 수십 초 뒤처진다). 송신 루프는 `snapshot()` 으로
그때그때의 최신 상태만 집어 간다.

FIX 유지 정책 (사용자 확정 2026-09-13)
--------------------------------------
FIX 가 끊겨도 **마지막 좌표를 지우지 않고 유지**하되 `fix=False` 로 내려보낸다.
좌표를 즉시 버리면 HOLD 30초 중 순간적인 FIX 끊김만으로 그 측정 지점이 통째로
좌표를 잃어 히트맵(X/Y 축이 실제 위경도)에 올리지 못한다. 대신 "지금 값이 아니다"는
사실을 반드시 함께 전달해 서버·대시보드가 경고를 띄운다 (CLAUDE.md 6절 —
오래된 데이터를 정상처럼 보여주는 것이 최악의 버그다).

사용법
    from gps import GpsReader
    g = GpsReader().start()
    ...
    s = g.snapshot()     # {"lat":…, "lon":…, "fix":bool, "age":초, "sats":n, …}

단독 점검 (서버·센서 없이 GPS 만):
    python3 gps.py --port /dev/ttyAMA0
"""

import threading
import time

DEFAULT_PORT = "/dev/ttyAMA0"
DEFAULT_BAUD = 9600
# 이 시간 넘게 새 FIX 가 없으면 fix=False. hi_flow_collector.py 의 10초를 그대로 쓴다.
DEFAULT_FIX_TIMEOUT = 10.0
REOPEN_DELAY = 2.0          # 포트 열기 실패 시 재시도 간격


def nmea_to_decimal(value, hemi):
    """NMEA 좌표(위도 ddmm.mmmm / 경도 dddmm.mmmm) → 십진 도. 못 읽으면 None.

    분(minute) 이 60 이상이면 깨진 문장이므로 버린다 — 체크섬을 통과해도
    반쪽짜리 버퍼를 이어 붙인 문장이 이렇게 들어올 수 있다.
    """
    if not value:
        return None
    try:
        raw = float(value)
    except (TypeError, ValueError):
        return None
    deg = int(raw // 100)
    minutes = raw - deg * 100.0
    if minutes >= 60.0 or minutes < 0.0:
        return None
    dec = deg + minutes / 60.0
    if hemi in ("S", "W"):
        return -dec
    if hemi in ("N", "E"):
        return dec
    return None                      # 반구 문자가 비었거나 깨졌다


def checksum_ok(line):
    """`$....*HH` 의 XOR 체크섬 검증. 체크섬이 안 붙은 문장은 통과시킨다.

    보트 위 배선은 잡음을 타기 쉽다. 체크섬을 보지 않으면 깨진 한 글자가
    좌표를 저수지 밖으로 날려 보내고, 그 값이 그대로 측정 레코드에 박힌다.
    """
    if "*" not in line:
        return True
    body, _, given = line[1:].partition("*")
    given = given.strip()[:2]
    if len(given) < 2:
        return False
    x = 0
    for ch in body:
        x ^= ord(ch)
    return f"{x:02X}" == given.upper()


def _valid(lat, lon):
    return (lat is not None and lon is not None
            and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0
            # 0,0 은 기니만 한복판 — 실전에서는 미초기화 값이다.
            and not (abs(lat) < 1e-9 and abs(lon) < 1e-9))


class GpsReader:
    """NMEA GGA/RMC 를 읽어 마지막 FIX 를 보관한다. 스레드 안전.

    GGA 와 RMC 를 모두 받는 이유: 모듈·펌웨어에 따라 둘 중 하나만 꾸준히 나오는
    경우가 있어 한쪽만 파싱하면 "RAW 는 들어오는데 FIX 가 안 잡힌다" 가 된다.
    """

    def __init__(self, port=DEFAULT_PORT, baud=DEFAULT_BAUD,
                 fix_timeout=DEFAULT_FIX_TIMEOUT):
        self.port = port
        self.baud = baud
        self.fix_timeout = fix_timeout

        self._lock = threading.Lock()
        self._lat = None
        self._lon = None
        self._sats = None
        self._fix_at = None          # 마지막 유효 FIX 시각 (monotonic)
        self._opened = False
        self._error = None
        self._sentences = 0          # 체크섬을 통과한 NMEA 문장 수 (배선 진단용)
        self._stop = threading.Event()
        self._thread = None

    # ── 수명 주기 ─────────────────────────────────────────────────────────
    def start(self):
        if self._thread is not None:
            return self
        self._thread = threading.Thread(target=self._run, name="gps", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()

    # ── 송신 루프가 읽는 창구 ─────────────────────────────────────────────
    def snapshot(self):
        """지금 시점의 GPS 상태 1건.

        lat/lon 은 **마지막으로 잡힌 FIX 를 계속 유지**한다(위 '유지 정책').
        지금 그 값이 유효한지는 `fix` 로만 판단하고, `age` 는 몇 초 묵었는지다.
        """
        now = time.monotonic()
        with self._lock:
            lat, lon, sats = self._lat, self._lon, self._sats
            fix_at, opened, error = self._fix_at, self._opened, self._error
            sentences = self._sentences
        age = None if fix_at is None else now - fix_at
        return {
            "lat": lat,
            "lon": lon,
            "sats": sats,
            "fix": age is not None and age <= self.fix_timeout,
            "age": age,
            "opened": opened,
            "error": error,
            "sentences": sentences,
        }

    # ── 파서 ─────────────────────────────────────────────────────────────
    def _store(self, lat, lon, sats=None):
        if not _valid(lat, lon):
            return
        with self._lock:
            self._lat = lat
            self._lon = lon
            if sats is not None:
                self._sats = sats
            self._fix_at = time.monotonic()

    def _parse_gga(self, parts):
        # $xxGGA,utc,lat,N,lon,E,fixQuality,numSats,HDOP,...
        if len(parts) < 8:
            return
        try:
            if int(parts[6] or 0) == 0:          # 0 = FIX 없음
                return
        except ValueError:
            return
        try:
            sats = int(parts[7]) if parts[7] else None
        except ValueError:
            sats = None
        self._store(nmea_to_decimal(parts[2], parts[3]),
                    nmea_to_decimal(parts[4], parts[5]), sats)

    def _parse_rmc(self, parts):
        # $xxRMC,utc,status,lat,N,lon,E,...   status: A=유효 / V=무효
        if len(parts) < 7 or parts[2] != "A":
            return
        self._store(nmea_to_decimal(parts[3], parts[4]),
                    nmea_to_decimal(parts[5], parts[6]))

    def feed_line(self, line):
        """NMEA 한 줄 처리. 시험용으로 직접 먹일 수도 있다(테스트에서 사용)."""
        line = line.strip()
        if not line.startswith("$") or not checksum_ok(line):
            return
        parts = line.split("*")[0].split(",")
        talker = parts[0]
        if talker.endswith("GGA"):
            self._parse_gga(parts)
        elif talker.endswith("RMC"):
            self._parse_rmc(parts)
        else:
            return
        with self._lock:
            self._sentences += 1

    # ── 수신 스레드 ───────────────────────────────────────────────────────
    def _run(self):
        try:
            import serial
        except ImportError:
            with self._lock:
                self._error = "pyserial 미설치 (pip install pyserial)"
            return

        while not self._stop.is_set():
            try:
                with serial.Serial(self.port, self.baud, timeout=1) as port:
                    with self._lock:
                        self._opened = True
                        self._error = None
                    while not self._stop.is_set():
                        raw = port.readline()
                        if not raw:
                            continue
                        self.feed_line(raw.decode("ascii", errors="ignore"))
            except Exception as exc:
                with self._lock:
                    self._opened = False
                    self._error = f"{type(exc).__name__}: {exc}"
                self._stop.wait(REOPEN_DELAY)
        with self._lock:
            self._opened = False


def describe(snap):
    """콘솔 한 줄 요약 — feed.py 로그와 단독 점검이 같은 문구를 쓴다."""
    if snap["lat"] is None:
        if not snap["opened"]:
            return f"포트 열림 실패 ({snap['error'] or '원인 미상'})"
        return f"FIX 대기 중 (NMEA {snap['sentences']}문장 수신)"
    pos = f"{snap['lat']:.6f}, {snap['lon']:.6f}"
    sats = "" if snap["sats"] is None else f" 위성 {snap['sats']}"
    if snap["fix"]:
        return f"{pos}{sats}"
    return f"{pos} [FIX 끊김 {snap['age']:.0f}초 — 마지막 위치 유지]"


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="GPS 단독 점검 (서버·센서 불필요)")
    p.add_argument("--port", default=DEFAULT_PORT)
    p.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    p.add_argument("--fix-timeout", type=float, default=DEFAULT_FIX_TIMEOUT)
    args = p.parse_args(argv)

    g = GpsReader(args.port, args.baud, args.fix_timeout).start()
    print(f"GPS {args.port} @ {args.baud} — Ctrl+C 로 종료")
    try:
        while True:
            time.sleep(1.0)
            print(f"[{time.strftime('%H:%M:%S')}] {describe(g.snapshot())}", flush=True)
    except KeyboardInterrupt:
        g.stop()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
