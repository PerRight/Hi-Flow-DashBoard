/**
 * mock-stream.js — 1단계 전용 목업 데이터 생성기.
 *
 * 2단계에서 이 파일만 실제 WebSocket 클라이언트로 교체한다.
 * 대시보드가 의존하는 공개 인터페이스는 아래 5개뿐:
 *
 *   stream.onLive(cb)          // live 메시지 (1 Hz 상시, 표시 전용 — 저장 금지)
 *   stream.onRecord(cb)        // 측정 레코드 (HOLD 구간에서만, 저장·히트맵 대상)
 *   stream.sendCommand(cmd)    // 'down' | 'stop' | 'up' | 'auto'  (윈치 명령)
 *   stream.onWinchState(cb)    // 윈치 제어 보조 정보(자동 여부·측정 경과 등, 스키마 외 UI용)
 *   stream.start() / stop()
 *
 * 두 채널 분리는 CLAUDE.md 1절(2026-08-05 개정)을 따른다.
 *   ① live      : {type,state,depth_est,ec,tds,temp,status} — 이동 중에도 1 Hz 상시
 *   ② 측정 레코드: {ts,survey,ec,tds,temp,depth,lat,lon,status} — depth 는 항상 0.5|1.0|1.5
 *
 * 실제 시스템에서 수심 상태기계는 라즈베리파이가 소유한다(CLAUDE.md 0·1절).
 * 여기서는 그 라즈베리파이 역할을 브라우저 안에서 흉내낼 뿐이다.
 */

import {
  DESCENT_RATE, ASCENT_RATE, DEPTH_LEVELS, HOLD_SECONDS,
  SITE, THRESHOLDS
} from './config.js';

// ── 난수 유틸 (재현 가능한 과거 차수 생성을 위해 시드 사용) ────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rndGlobal = mulberry32(Date.now() & 0xffff);

// ── 계절 기준 수온 (오늘 날짜 기준으로 고정, ±0.5 변동) ────────────────────
function seasonalSurfaceTemp(date = new Date()) {
  // 실측 4.5~29.7℃ 범위를 1년 사인파로 근사. 최저 1월 중순, 최고 8월 초.
  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const mid = (29.7 + 4.5) / 2;
  const amp = (29.7 - 4.5) / 2;
  return mid - amp * Math.cos((2 * Math.PI * (doy - 15)) / 365);
}

/** 수심에 따른 수온 감쇠 (표층 대비 얕은 성층) */
function tempAtDepth(surface, depth) {
  return surface - depth * 1.2;
}

/**
 * 위치·수심 기반 EC 기본값.
 * 실측 116~256 µS/cm 를 공간 구배 + 수심 구배로 재현한다.
 */
function baseEC(lat, lon, depth, rnd) {
  const nx = (lon - SITE.lon) / SITE.spanLon; // -1..1
  const ny = (lat - SITE.lat) / SITE.spanLat;
  const [lo, hi] = THRESHOLDS.ec.observed;    // 116 ~ 256
  const mid = (lo + hi) / 2;
  const spatial = (nx * 0.55 + ny * 0.42) * (hi - lo) * 0.5;
  const vertical = depth * 12;                // 깊을수록 약간 높음
  return mid + spatial + vertical + (rnd() - 0.5) * 8;
}

/**
 * TDS(ppm) ≈ EC × 0.5 ± 잡음. 실센서도 같은 팩터로 환산해 준다(CLAUDE.md 1절).
 * EC 가 NaN 이면 TDS 도 값이 없다 — 꾸며 내지 않는다.
 */
const TDS_FACTOR = 0.5;
function baseTDS(ec, rnd) {
  if (Number.isNaN(ec)) return NaN;
  return ec * TDS_FACTOR + (rnd() - 0.5) * 3.0;
}

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

// 측정 수심 판정 허용 오차. 이 안에 들어와야 측정 레코드를 만든다.
const LEVEL_EPS = 0.05;

/** 현재 수심이 측정 수심(0.5/1.0/1.5)인지 — 아니면 null (측정 레코드 생성 안 함) */
function snapLevel(d) {
  for (const l of DEPTH_LEVELS) if (Math.abs(d - l) < LEVEL_EPS) return l;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 과거 차수 생성 (차수 선택 드롭다운 검증용)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 완료된 조사 차수 하나를 통째로 만든다.
 * 보트가 격자 형태로 이동하며 각 지점에서 3개 수심을 측정한 결과.
 */
function generateSurvey(surveyNo, seed, startTs, opts = {}) {
  const rnd = mulberry32(seed);
  const cols = opts.cols ?? 11;
  const rows = opts.rows ?? 10;
  const surfaceTemp = opts.surfaceTemp ?? seasonalSurfaceTemp();
  const records = [];
  let ts = startTs;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 보트가 지그재그(뱀 모양)로 이동
      const cc = r % 2 === 0 ? c : cols - 1 - c;
      const lat = SITE.lat + (r / (rows - 1) - 0.5) * 2 * SITE.spanLat * 0.85
        + (rnd() - 0.5) * 0.00012;
      const lon = SITE.lon + (cc / (cols - 1) - 0.5) * 2 * SITE.spanLon * 0.85
        + (rnd() - 0.5) * 0.00012;

      for (const depth of DEPTH_LEVELS) {
        // 각 수심에서 HOLD_SECONDS 동안 1 Hz 측정 → 대표 표본만 남기지 않고 전부 기록
        for (let s = 0; s < HOLD_SECONDS; s++) {
          let ec = baseEC(lat, lon, depth, rnd);
          let temp = tempAtDepth(surfaceTemp, depth) + (rnd() - 0.5);
          let status = 'ok';

          // 국지 오염원: 특정 구역에서 EC 상승 (주의/위험 구간 검증용)
          if (opts.hotspot && r >= opts.hotspot.r0 && r <= opts.hotspot.r1 &&
              cc >= opts.hotspot.c0 && cc <= opts.hotspot.c1) {
            ec += opts.hotspot.boost * (0.6 + depth / 1.5 * 0.4);
          }

          let tds = baseTDS(ec, rnd);   // EC 확정 후 환산 (실센서와 같은 순서)

          // 드문 fault (센서 순간 이상)
          if (rnd() < 0.004) {
            status = 'fault';
            if (rnd() < 0.5) { ec = NaN; tds = NaN; } else ec = -12.4;
          }

          records.push({
            ts: ts++,
            survey: surveyNo,
            ec: Number.isNaN(ec) ? NaN : round(ec, 1),
            tds: Number.isNaN(tds) ? NaN : round(tds, 1),
            temp: round(temp, 1),
            depth,
            lat: round(lat, 6),
            lon: round(lon, 6),
            status
          });
        }
        ts += 40; // 다음 수심으로 이동하는 시간
      }
      ts += 60;   // 다음 지점으로 보트 이동
    }
  }
  return records;
}

/** 완료된 과거 차수 2건을 반환 (차수 1, 2) */
export function generateHistoricalSurveys(now = Math.floor(Date.now() / 1000)) {
  const surfaceTemp = seasonalSurfaceTemp();
  return [
    {
      survey: 1,
      label: '1차 (완료)',
      records: generateSurvey(1, 11117, now - 86400 * 14, {
        surfaceTemp: surfaceTemp - 1.4,
        hotspot: { r0: 0, r1: 2, c0: 8, c1: 10, boost: 110 }  // 주의(>280) 구간 진입
      })
    },
    {
      survey: 2,
      label: '2차 (완료)',
      records: generateSurvey(2, 24601, now - 86400 * 7, {
        surfaceTemp: surfaceTemp - 0.6,
        hotspot: { r0: 7, r1: 9, c0: 0, c1: 2, boost: 640 }   // 위험(>700) 구간 진입
      })
    }
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// 실시간 목업 스트림
// ═══════════════════════════════════════════════════════════════════════════

export const WINCH = {
  SURFACE: 'SURFACE',
  DESCENDING: 'DESCENDING',
  HOLD: 'HOLD',
  ASCENDING: 'ASCENDING'
};

export function createMockStream(options = {}) {
  const liveSurvey = options.survey ?? 3;
  const liveCbs = [];
  const recordCbs = [];
  const stateCbs = [];

  let timer = null;
  let running = false;

  // 보트 위치 (수면 대기 중에만 천천히 이동)
  let lat = SITE.lat - SITE.spanLat * 0.6;
  let lon = SITE.lon - SITE.spanLon * 0.6;
  let heading = Math.PI * 0.35;

  const surfaceTemp = seasonalSurfaceTemp();

  // 윈치 상태기계
  let winch = WINCH.SURFACE;
  let depth = 0;
  let holdElapsed = 0;
  let targetLevelIdx = 0;      // 자동 모드에서 다음에 멈출 수심 인덱스
  let auto = true;
  let surfaceWait = 0;

  // 장애 주입
  let staleRemaining = 0;      // >0 이면 이 초 동안 아무것도 방출하지 않음
  let nextStaleIn = 45 + Math.floor(rndGlobal() * 40);

  /**
   * 윈치 제어 보조 정보. 상태(state)·수심(depth_est)은 live 메시지가 정본이므로
   * 여기서는 중복해서 보내지 않는다(표시 이중 출처 방지).
   */
  function emitState() {
    const s = {
      auto,
      holdElapsed,
      holdTotal: HOLD_SECONDS,
      nextLevel: DEPTH_LEVELS[targetLevelIdx] ?? null,
      levels: DEPTH_LEVELS
    };
    stateCbs.forEach((cb) => cb(s));
  }

  function moveBoat() {
    // 수면 대기 중일 때만 이동 (프로브가 내려가 있으면 정지)
    if (winch !== WINCH.SURFACE) return;
    heading += (rndGlobal() - 0.5) * 0.25;
    // 조사 보트 이동 속도 약 1 m/s (위도 1도 ≈ 111 km 기준)
    const step = 0.0000082 + rndGlobal() * 0.0000030;
    let nLat = lat + Math.cos(heading) * step;
    let nLon = lon + Math.sin(heading) * step * 1.25;
    // 저수지 경계 반사
    if (Math.abs(nLat - SITE.lat) > SITE.spanLat) { heading = Math.PI - heading; nLat = lat; }
    if (Math.abs(nLon - SITE.lon) > SITE.spanLon) { heading = -heading; nLon = lon; }
    lat = nLat; lon = nLon;
  }

  /** 윈치 상태기계 1초 진행 */
  function stepWinch() {
    switch (winch) {
      case WINCH.SURFACE:
        depth = 0;
        if (auto) {
          surfaceWait += 1;
          if (surfaceWait >= 45) {   // 다음 측점(약 45 m 이동)까지 이동 후 재하강
            surfaceWait = 0;
            targetLevelIdx = 0;
            winch = WINCH.DESCENDING;
          }
        }
        break;

      case WINCH.DESCENDING: {
        depth += DESCENT_RATE;
        const target = DEPTH_LEVELS[targetLevelIdx];
        if (auto && target !== undefined && depth >= target - 1e-9) {
          depth = target;
          holdElapsed = 0;
          winch = WINCH.HOLD;
        }
        const deepest = DEPTH_LEVELS[DEPTH_LEVELS.length - 1];
        if (depth >= deepest) {      // 수동 모드라도 최심부에서는 정지
          depth = deepest;
          holdElapsed = 0;
          winch = WINCH.HOLD;
        }
        break;
      }

      case WINCH.HOLD:
        holdElapsed += 1;
        if (auto && holdElapsed >= HOLD_SECONDS) {
          holdElapsed = 0;
          targetLevelIdx += 1;
          if (targetLevelIdx < DEPTH_LEVELS.length) winch = WINCH.DESCENDING;
          else { targetLevelIdx = 0; winch = WINCH.ASCENDING; }
        }
        break;

      case WINCH.ASCENDING:
        depth -= ASCENT_RATE;
        if (depth <= 0) { depth = 0; winch = WINCH.SURFACE; surfaceWait = 0; }
        break;
    }
  }

  function tick() {
    // stale 주입: 이 구간에는 live·측정 레코드를 아예 방출하지 않는다 (Wi-Fi 끊김 재현)
    if (staleRemaining > 0) {
      staleRemaining -= 1;
      stepWinch();  // 라즈베리파이는 계속 돌지만 대시보드로는 전달되지 않음
      return;
    }
    nextStaleIn -= 1;
    if (nextStaleIn <= 0) {
      staleRemaining = 3 + Math.floor(rndGlobal() * 3);  // 3~5초 무송신
      nextStaleIn = 60 + Math.floor(rndGlobal() * 60);
      return;
    }

    moveBoat();
    stepWinch();

    const d = round(depth, 3);
    let ec = baseEC(lat, lon, d, rndGlobal);
    let temp = tempAtDepth(surfaceTemp, d) + (rndGlobal() - 0.5);
    let status = 'ok';

    // 가끔 주의 구간(>280), 드물게 위험 구간(>700) 삽입
    const roll = rndGlobal();
    if (roll < 0.006) ec += 300 + rndGlobal() * 200;        // 주의: 280~700
    else if (roll < 0.008) ec += 600 + rndGlobal() * 400;   // 위험: >700

    let tds = baseTDS(ec, rndGlobal);   // EC 확정 후 환산 (실센서와 같은 순서)

    // fault 주입: NaN 또는 물리적으로 불가능한 범위 밖 값
    const froll = rndGlobal();
    if (froll < 0.006) {
      status = 'fault';
      if (froll < 0.002) { ec = NaN; tds = NaN; }
      else if (froll < 0.004) tds = 12500;                  // TDS 범위 밖 (0~10000 ppm)
      else temp = -20.1;                                    // 수온 범위 밖
    }

    ec = Number.isNaN(ec) ? NaN : round(ec, 1);
    tds = Number.isNaN(tds) ? NaN : round(tds, 1);
    temp = Number.isNaN(temp) ? NaN : round(temp, 1);

    // ① live — 1 Hz 상시. 이동(DESCENDING/ASCENDING) 중에도 나가며, 저장하지 않는다.
    const live = {
      type: 'live',
      state: winch,
      depth_est: d,
      ec, tds, temp,
      status
    };
    liveCbs.forEach((cb) => cb(live));

    // ② 측정 레코드 — HOLD 이고 측정 수심(0.5/1.0/1.5)에 있을 때만.
    //    같은 초의 센서 표본을 공유하고 GPS·차수·시각만 덧붙인다.
    const level = winch === WINCH.HOLD ? snapLevel(depth) : null;
    if (level !== null) {
      const rec = {
        ts: Math.floor(Date.now() / 1000),
        survey: liveSurvey,
        ec, tds, temp,
        depth: level,
        lat: round(lat, 6),
        lon: round(lon, 6),
        status
      };
      recordCbs.forEach((cb) => cb(rec));
    }

    emitState();
  }

  return {
    survey: liveSurvey,

    /** live 메시지 (1 Hz 상시) — 게이지·수심·시계열 전용. 저장하지 않는다. */
    onLive(cb) { liveCbs.push(cb); return () => liveCbs.splice(liveCbs.indexOf(cb), 1); },

    /** 측정 레코드 (HOLD 구간에서만) — 저장·히트맵·차수 조회·내보내기 대상. */
    onRecord(cb) { recordCbs.push(cb); return () => recordCbs.splice(recordCbs.indexOf(cb), 1); },
    onWinchState(cb) { stateCbs.push(cb); return () => stateCbs.splice(stateCbs.indexOf(cb), 1); },

    /** 대시보드 → 라즈베리파이 윈치 명령 (CLAUDE.md 0절: 대시보드는 명령만 보낸다) */
    sendCommand(cmd) {
      switch (cmd) {
        case 'down':
          auto = false;
          if (depth < DEPTH_LEVELS[DEPTH_LEVELS.length - 1]) winch = WINCH.DESCENDING;
          break;
        case 'stop':
          auto = false;
          winch = depth <= 0 ? WINCH.SURFACE : WINCH.HOLD;
          holdElapsed = 0;
          break;
        case 'up':
          auto = false;
          winch = depth > 0 ? WINCH.ASCENDING : WINCH.SURFACE;
          break;
        case 'auto':
          auto = true;
          // 현재 수심보다 깊은 첫 목표를 다음 정지점으로 삼는다
          targetLevelIdx = Math.max(0, DEPTH_LEVELS.findIndex((l) => l > depth + 1e-9));
          if (targetLevelIdx < 0) targetLevelIdx = 0;
          break;
        default:
          console.warn('[mock-stream] 알 수 없는 명령:', cmd);
      }
      emitState();
    },

    /** 장애 모드 수동 주입 (6절 실패 모드 UI 검증용) */
    injectStale(seconds = 4) { staleRemaining = seconds; },

    start() {
      if (running) return;
      running = true;
      timer = setInterval(tick, 1000);
      emitState();
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
    }
  };
}
