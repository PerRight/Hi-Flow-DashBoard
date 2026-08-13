/**
 * config.js — CLAUDE.md 1절(데이터 명세)을 코드로 옮긴 단일 진실 공급원.
 * 이 파일의 값을 바꾸려면 반드시 CLAUDE.md 1절을 먼저 고치고 사용자 확인을 받는다.
 */

// ── 값 범위·임계값 (세종 용암저수지 2010~2026 실측 76건 기반) ──────────────
export const THRESHOLDS = {
  ec: {
    label: 'EC',
    unit: 'µS/cm',
    normal: [100, 280],     // 정상
    caution: [280, 700],    // 주의
    // >700 = 위험 (FAO 관개용수 기준)
    fault: [0, 20000],      // 이 밖이면 물리적으로 불가능 → fault
    observed: [116, 256]    // 실측 관측 범위 (목업 중심값)
  },
  tds: {
    label: 'TDS',
    unit: 'ppm',
    normal: [50, 140],      // 정상
    caution: [140, 350],    // 주의
    // >350 = 위험 (EC×0.5 환산 근사, 센서 TDS 팩터 0.5 가정)
    fault: [0, 10000],      // 이 밖이면 물리적으로 불가능 → fault
    observed: [58, 128]     // EC 실측 116~256 × 0.5
  },
  temp: {
    label: '수온',
    unit: '℃',
    normal: [0, 35],        // 범위 밖 = fault (주의 구간 없음)
    fault: [0, 35],
    observed: [4.5, 29.7]
  }
};

// ── 수심 추정 상수 (CLAUDE.md 1절, 실측 보정 전까지 가안) ─────────────────
export const DESCENT_RATE = 0.5 / 30;  // ≈0.01667 m/s (30초 → 0.5 m, 사용자 확정 2026-08-10)
// ASCENT_RATE 는 CLAUDE.md 에서 TBD. 목업 시뮬레이션을 돌리기 위한 임시 placeholder로
// 하강 속도와 동일하게 둔다. 상승 속도 실측 후 CLAUDE.md 1절을 먼저 갱신할 것.
export const ASCENT_RATE = DESCENT_RATE; // TBD — 실측 필요
export const DEPTH_LEVELS = [0.5, 1.0, 1.5];
export const HOLD_SECONDS = 30;      // 각 수심에서 측정 유지 시간(목업)

// ── 실패 모드 (CLAUDE.md 6절) ──────────────────────────────────────────────
export const STALE_MS = 2000;        // 2초 이상 미수신 → stale

// ── 갱신 주기 (CLAUDE.md 3절) ─────────────────────────────────────────────
export const TICK_FAST_MS = 1000;    // 게이지·시계열
export const TICK_BATCH_MS = 3000;   // 히트맵·지도 궤적
export const SERIES_WINDOW_S = 300;  // 시계열 최근 5분

// ── 조사 지점 (세종 용암저수지) ────────────────────────────────────────────
export const SITE = {
  name: '세종 용암저수지',
  lat: 36.5751,
  lon: 127.2214,
  // 저수지 대략 반경 (도 단위) — 목업 궤적 생성 범위
  spanLat: 0.0022,
  spanLon: 0.0028
};

// ── 서버 (라즈베리파이 FastAPI) ────────────────────────────────────────────
// 기본값은 대시보드를 서빙한 호스트의 8000 포트.
// Vite dev(localhost:5173)에서는 http://localhost:8000 · ws://localhost:8000 이 되고,
// 라즈베리파이 핫스팟에서 dist 를 서빙하면 그 IP 로 자동으로 붙는다.
const SERVER_HOST = `${globalThis.location?.hostname || 'localhost'}:8000`;
export const SERVER = {
  http: `http://${SERVER_HOST}`,
  ws: `ws://${SERVER_HOST}`
};

// ── 히트맵 (CLAUDE.md 1절: 컬러 도메인 [100,280] 고정) ─────────────────────
export const HEATMAP = {
  colorDomain: [100, 280],
  cellSize: 45,            // m — 목업 측점 간격(약 45~60 m)에 맞춘 값
  elevationScale: 0.35,    // 높이 = EC × 이 계수 (원점을 지나는 선형 → 값 비례)
  // 정상 구간 [100,280] 6단계
  colorRange: [
    [ 26, 152, 130],
    [102, 194, 165],
    [171, 221, 164],
    [255, 255, 191],
    [253, 174,  97],
    [244, 109,  67]
  ],
  overColor: [123, 31, 122],   // 280 초과 = 짙은 자주 (전용 경고색)
  dangerColor: [ 74, 12, 85]   // 700 초과 = 더 짙은 자주
};

// ── 지도 (VWorld 위성 타일 / 키 없으면 OSM 폴백) ───────────────────────────
// VWorld 오픈API 키를 넣으면 위성 타일로 자동 전환된다.
export const VWORLD_KEY = '';

/** EC/TDS/수온 값을 정상/주의/위험/fault 등급으로 분류 */
export function classify(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'fault';
  if (metric === 'ec') {
    if (value < THRESHOLDS.ec.fault[0] || value > THRESHOLDS.ec.fault[1]) return 'fault';
    if (value > 700) return 'danger';
    if (value > 280) return 'caution';
    if (value < 100) return 'caution';
    return 'normal';
  }
  if (metric === 'tds') {
    if (value < THRESHOLDS.tds.fault[0] || value > THRESHOLDS.tds.fault[1]) return 'fault';
    if (value > 350) return 'danger';
    if (value > 140) return 'caution';
    if (value < 50) return 'caution';   // EC 와 같은 규칙 — 정상 대역 아래도 주의
    return 'normal';
  }
  if (metric === 'temp') {
    if (value < 0 || value > 35) return 'fault';
    return 'normal';
  }
  return 'normal';
}

/** 레코드 하나가 히트맵 집계에 쓸 수 있는지 (CLAUDE.md 6절: fault 는 집계 제외) */
export function isAggregatable(rec) {
  return rec.status === 'ok' &&
    Number.isFinite(rec.ec) &&
    Number.isFinite(rec.lat) &&
    Number.isFinite(rec.lon);
}
