"""
config.py — CLAUDE.md 1절(데이터 명세)을 파이썬으로 옮긴 단일 진실 공급원.

이 파일의 값은 dashboard/src/config.js 와 반드시 같아야 한다.
값을 바꾸려면 CLAUDE.md 1절을 먼저 고치고 사용자 확인을 받는다.
"""

import os

# ── 수심 추정 상수 (CLAUDE.md 1절, 실측 보정 전까지 가안) ────────────────────
DESCENT_RATE = 0.5 / 30       # ≈0.01667 m/s (30초 → 0.5 m, 사용자 확정 2026-08-10)
# ASCENT_RATE 는 CLAUDE.md 에서 TBD. 시뮬레이션을 돌리기 위한 임시 placeholder 로
# 하강 속도와 동일하게 둔다. 상승 속도 실측 후 CLAUDE.md 1절을 먼저 갱신할 것.
ASCENT_RATE = DESCENT_RATE     # TBD — 실측 필요
DEPTH_LEVELS = [0.5, 1.0, 1.5]
HOLD_SECONDS = 30              # 각 측정 수심에서 유지하는 시간
# 도착 직후 이 시간만큼은 대표값 산출에서 버린다 (사용자 확정 2026-08-28).
# 프로브가 내려오면서 주변 물을 흔들어 놓기 때문에 초반 값은 그 수심의 값이 아니다.
# 즉 30초 중 뒤 20초만 평균한다. 실측 보정 후 조정 가능.
SETTLE_SECONDS = 10
LEVEL_EPS = 0.05               # 이 오차 안에 들어와야 측정 수심으로 인정
SURFACE_WAIT_SECONDS = 45      # (미사용) 자동 순환 삭제 2026-08-28 — 호환용으로만 남김

# ── 실패 모드 (CLAUDE.md 6절) ──────────────────────────────────────────────
STALE_SECONDS = 2.0            # ESP32 원시 표본 2초 이상 미수신 → status='stale'

# ── 갱신 주기 (CLAUDE.md 3절) ─────────────────────────────────────────────
TICK_SECONDS = 1.0             # live 브로드캐스트 1 Hz
COMMIT_INTERVAL_SECONDS = 5.0  # SQLite 5초 단위 트랜잭션 배치

# ── 값 범위 (세종 용암저수지 2010~2026 실측 76건 기반) ──────────────────────
# 서버는 fault 판정(물리적으로 불가능한 값)만 한다.
# 주의/위험 임계값은 표시 색상용이라 대시보드(config.js)가 소유한다.
EC_FAULT_RANGE = (0.0, 20000.0)    # 이 밖이면 물리적으로 불가능 → fault
TDS_FAULT_RANGE = (0.0, 10000.0)   # CLAUDE.md 1절 (2026-08-10, pH 대체)
TEMP_FAULT_RANGE = (0.0, 35.0)     # 수온 정상 0~35, 범위 밖 = fault
EC_OBSERVED = (116.0, 256.0)       # 실측 관측 범위 (목업 중심값)
TEMP_OBSERVED = (4.5, 29.7)
TDS_FACTOR = 0.5                   # TDS ≈ EC × 0.5 (센서 팩터 가정, CLAUDE.md 1절)

# ── 조사 지점 (세종 용암저수지) ────────────────────────────────────────────
SITE_NAME = "세종 용암저수지"
SITE_LAT = 36.5751
SITE_LON = 127.2214
SITE_SPAN_LAT = 0.0022         # 저수지 대략 반경 (도 단위)
SITE_SPAN_LON = 0.0028

# ── 런타임 설정 (환경변수) ─────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("UWD_DB", os.path.join(_HERE, "data", "records.db"))

# 목업 사용 여부. 기본 비활성(CLAUDE.md 1절 — 실기 feed 가 끊겼을 때 목업이 조용히
# 이어받아 가짜 값을 ok 로 표시하는 것을 막는다). 개발·시연 시에만 UWD_MOCK=1 로 켠다.
# 실제 ESP32 가 /ws/ingest 로 접속하면 켜져 있어도 코드가 자동으로 목업을 멈춘다.
USE_MOCK = os.environ.get("UWD_MOCK", "0") == "1"  # "1"만 활성 — 그 외 값·오타는 전부 비활성(안전측)

# 장착 센서 목록 (CLAUDE.md 1절). 여기 나열된 항목만 status 판정에 참여하고,
# 미장착 항목은 null 송신·NULL 저장을 유지한다.
# EC/TDS 일체형 센서는 세 항목을 모두 준다 → 기본값 그대로 두면 되고,
# UWD_SENSORS 를 따로 지정할 일이 없다(센서 하나가 고장 났을 때의 임시 수단).
ALL_SENSORS = ("ec", "tds", "temp")
_requested = {s.strip().lower() for s in os.environ.get("UWD_SENSORS", "ec,tds,temp").split(",")}
_unknown = sorted(s for s in _requested if s and s not in ALL_SENSORS)
SENSORS = tuple(s for s in ALL_SENSORS if s in _requested)
if _unknown:
    print(f"[config] UWD_SENSORS 무시된 항목: {_unknown} (유효: {list(ALL_SENSORS)})", flush=True)
if not SENSORS:
    # 전부 비우면 어떤 값이든 ok 로 보이게 되어 6절 최악의 버그가 된다 → 기본값으로 되돌린다.
    print("[config] UWD_SENSORS 가 비어 기본값(ec,tds,temp)을 사용한다.", flush=True)
    SENSORS = ALL_SENSORS

# 시험 전용 시간 배속. 1 틱(1초)마다 상태기계를 이 배수만큼 진행시킨다.
# 물리 상수(DESCENT_RATE 등)는 건드리지 않으며, 브로드캐스트는 언제나 1 Hz 다.
# 현장/운영에서는 반드시 1.0 (기본값).
TIME_SCALE = float(os.environ.get("UWD_TIME_SCALE", "1.0"))
