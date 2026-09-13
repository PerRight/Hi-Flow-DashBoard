/**
 * config.js — CLAUDE.md 1절(데이터 명세)을 코드로 옮긴 단일 진실 공급원.
 * 이 파일의 값을 바꾸려면 반드시 CLAUDE.md 1절을 먼저 고치고 사용자 확인을 받는다.
 */

// ── 값 범위·임계값 (세종 용암저수지 2010~2026 실측 76건 기반) ──────────────
export const THRESHOLDS = {
  ec: {
    label: 'EC',
    unit: 'µS/cm',
    normal: [0, 280],       // 정상 (하한 미만도 정상 — 사용자 확정 2026-08-28)
    caution: [280, 700],    // 주의
    // >700 = 위험 (FAO 관개용수 기준)
    fault: [0, 20000],      // 이 밖이면 물리적으로 불가능 → fault
    observed: [116, 256]    // 실측 관측 범위 (목업 중심값)
  },
  tds: {
    label: 'TDS',
    unit: 'ppm',
    normal: [0, 140],       // 정상 (하한 미만도 정상 — 사용자 확정 2026-08-28)
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

// ── 게이지 눈금 범위 (표시용 — 임계값이 아니다, 사용자 확정 2026-08-28) ──────
// 바늘이 도는 범위. 임계값은 위 THRESHOLDS 가 정답이고 여기는 스케일일 뿐이다.
export const GAUGE_SCALE = {
  temp: [0, 50],
  ec: [0, 1000],
  tds: [0, 500]
};

// ── 수심 추정 상수 (CLAUDE.md 1절, 실측 보정 전까지 가안) ─────────────────
export const DESCENT_RATE = 0.5 / 30;  // ≈0.01667 m/s (30초 → 0.5 m, 사용자 확정 2026-08-10)
// ASCENT_RATE 는 CLAUDE.md 에서 TBD. 목업 시뮬레이션을 돌리기 위한 임시 placeholder로
// 하강 속도와 동일하게 둔다. 상승 속도 실측 후 CLAUDE.md 1절을 먼저 갱신할 것.
export const ASCENT_RATE = DESCENT_RATE; // TBD — 실측 필요
export const DEPTH_LEVELS = [0.5, 1.0, 1.5];
// 수심 층 이름 (사용자 확정 2026-09-02) — 숫자만으로는 층 구분이 직관적이지 않다.
// 화면에는 항상 "표층 0.5 m" 처럼 이름과 수치를 함께 쓴다.
export const DEPTH_LAYERS = { '0.5': '표층', '1.0': '중층', '1.5': '저층' };
export const layerName = (d) => DEPTH_LAYERS[Number(d).toFixed(1)] ?? '';
export const layerLabel = (d) => `${layerName(d)} ${Number(d).toFixed(1)} m`.trim();
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

// ── 서버 연결 주소 ────────────────────────────────────────────────────────
// 세 가지 환경에서 모두 동작해야 한다:
//   ① Vite dev (localhost:5173)      → http://localhost:8000 · ws://localhost:8000
//   ② 라즈베리파이 핫스팟 (평문 8000) → 그 IP 의 8000 포트
//   ③ 클라우드 nginx 뒤 (HTTPS 443)  → 같은 오리진, wss://
//
// ③이 중요하다: HTTPS 페이지에서 ws:// 를 열면 브라우저가 mixed content 로
// 차단해 대시보드가 조용히 죽는다. 반드시 wss:// 를 써야 한다 (CLAUDE.md 0절).
// nginx 가 /ws/ 를 8000 으로 넘겨주므로 포트를 붙이지 않고 같은 오리진을 쓴다.
const _loc = globalThis.location;
const _secure = _loc?.protocol === 'https:';
const SERVER_HOST = _secure ? _loc.host : `${_loc?.hostname || 'localhost'}:8000`;
export const SERVER = {
  http: `${_secure ? 'https' : 'http'}://${SERVER_HOST}`,
  ws: `${_secure ? 'wss' : 'ws'}://${SERVER_HOST}`
};

// ── 3D 히트맵 (CLAUDE.md 1절: 컬러 도메인·임계값 고정) ─────────────────
// 표현 형식은 (X,Y,수심) 3차원 산점으로 확정 (사용자 확정 2026-08-26,
// design/UI_REQUIREMENTS.md §3.10). deck.gl GridLayer 평면 슬라이스를 대체한다.
// 바뀐 것은 "그리는 방식"이고, 임계값과 컬러 도메인은 1절 표 그대로다.

// 정상 대역은 **단일 파랑 한 색**이다 (사용자 확정 2026-08-28 — 13단계 그라데이션 폐기).
// 값의 크기는 막대 높이가 이미 선형으로 나타내므로 색까지 단계로 나눌 필요가 없고,
// 범례도 주의·위험과 같은 한 칸짜리 색 표기로 통일된다.
// 정상 상한을 넘으면 전용 경고색 + 형태 변화로 구분한다
// (색만으로 구분하지 않는다 — 색각 이상 대응, UI_REQUIREMENTS §7).
const NORMAL_BLUE = '#2A78D6';

export const HEATMAP_3D = {
  normalColor: NORMAL_BLUE,
  metrics: {
    ec: {
      label: 'EC',
      unit: 'µS/cm',
      normalMax: 280,            // CLAUDE.md 1절: EC 정상 상한 (0~280 전부 정상 = 파랑 한 색)
      dangerMin: 700,            // CLAUDE.md 1절: EC 위험 임계값
      normalColor: NORMAL_BLUE,
      overColor: '#F0A10D',      // 주의(정상 상한 초과) — 사용자 지정 2026-09-06
      dangerColor: '#D00000'     // 위험 — 사용자 지정 2026-09-06
    },
    tds: {
      label: 'TDS',
      unit: 'ppm',
      normalMax: 140,            // CLAUDE.md 1절: TDS 정상 상한 (0~140 전부 정상)
      dangerMin: 350,            // CLAUDE.md 1절: TDS 위험 임계값
      normalColor: NORMAL_BLUE,
      overColor: '#F0A10D',
      dangerColor: '#D00000'
    }
  }
};

// ── 지도 (VWorld 위성 타일 / 키 없으면 OSM 폴백) ───────────────────────────
// VWorld 오픈API 키를 넣으면 위성 타일로 자동 전환된다.
export const VWORLD_KEY = '';

/**
 * EC/TDS/수온 값을 정상/주의/위험/fault 등급으로 분류.
 * 하한 미만(EC <100, TDS <50)은 **정상**이다 — 저농도는 수질 이상이 아니다
 * (사용자 확정 2026-08-28, CLAUDE.md 1절 표 개정).
 */
export function classify(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'fault';
  if (metric === 'ec') {
    if (value < THRESHOLDS.ec.fault[0] || value > THRESHOLDS.ec.fault[1]) return 'fault';
    if (value > 700) return 'danger';
    if (value > 280) return 'caution';
    return 'normal';                    // 100 미만 포함
  }
  if (metric === 'tds') {
    if (value < THRESHOLDS.tds.fault[0] || value > THRESHOLDS.tds.fault[1]) return 'fault';
    if (value > 350) return 'danger';
    if (value > 140) return 'caution';
    return 'normal';                    // 50 미만 포함
  }
  if (metric === 'temp') {
    if (value < 0 || value > 35) return 'fault';
    return 'normal';
  }
  return 'normal';
}

/** 레코드 하나가 히트맵 집계에 쓸 수 있는지 (CLAUDE.md 6절: fault 는 집계 제외) */
export function isAggregatable(rec, metric = 'ec') {
  return rec.status === 'ok' &&
    Number.isFinite(rec[metric]) &&
    Number.isFinite(rec.lat) &&
    Number.isFinite(rec.lon);
}
