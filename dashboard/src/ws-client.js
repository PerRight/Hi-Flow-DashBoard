/**
 * ws-client.js — 2단계 실시간 클라이언트 (라즈베리파이 FastAPI 서버 연결).
 *
 * 1단계 mock-stream.js 를 그대로 대체한다. 공개 인터페이스는 동일하다:
 *
 *   client.onLive(cb)          // live 메시지 (1 Hz 상시, 표시 전용 — 저장 금지)
 *   client.onRecord(cb)        // 측정 레코드 (HOLD 구간에서만, 저장·히트맵 대상)
 *   client.onWinchState(cb)    // 윈치 조작 보조 정보(스키마 외 UI 전용)
 *   client.sendCommand(cmd)    // 'down' | 'stop' | 'up' | 'auto' | 'survey_start' | 'survey_end'
 *   client.injectStale(s)      // 연결 끊김 UI 검증용(로컬에서만 수신을 잠시 무시)
 *   client.start() / stop()
 *
 * 서버가 보내는 두 채널 구분 (CLAUDE.md 1절):
 *   ① live       : {"type":"live", ...}          → onLive
 *   ② 측정 레코드 : type 없이 {survey, depth,...} → onRecord
 *
 * 재연결은 지수 백오프, 최대 10초 (CLAUDE.md 4절 — 절대 보존).
 * 연결이 끊기면 live 가 끊기므로 main.js 의 stale 감시가 2초 뒤 자동으로 동작한다.
 */

import { DEPTH_LEVELS, HOLD_SECONDS, SERVER } from './config.js';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10000;   // CLAUDE.md 4절: 최대 10초

/** 과거 차수 목록 (REST). 반환: {active, active_recording, surveys:[{survey,count,...}]} */
export async function fetchSurveys() {
  const res = await fetch(`${SERVER.http}/surveys`);
  if (!res.ok) throw new Error(`/surveys ${res.status}`);
  return res.json();
}

/** 차수별 측정 레코드 (REST). 대시보드는 조회만 하고 가공하지 않는다. */
export async function fetchRecords(survey) {
  const res = await fetch(`${SERVER.http}/records?survey=${encodeURIComponent(survey)}`);
  if (!res.ok) throw new Error(`/records ${res.status}`);
  const body = await res.json();
  return body.records ?? [];
}

/** CSV 내보내기 URL (조사 종료 시 백업 — CLAUDE.md 6절) */
export function exportUrl(survey, format = 'csv') {
  return `${SERVER.http}/export?survey=${encodeURIComponent(survey)}&format=${format}`;
}

export function createWsClient(options = {}) {
  const url = options.url ?? `${SERVER.ws}/ws/dashboard`;
  const liveCbs = [];
  const recordCbs = [];
  const stateCbs = [];
  const linkCbs = [];

  let ws = null;
  let running = false;
  let retryTimer = null;
  let backoff = RECONNECT_MIN_MS;
  let ignoreUntil = 0;          // injectStale 로 수신을 무시할 시각(ms)

  // ── 윈치 보조 정보 ────────────────────────────────────────────────────
  // 서버가 이 정보를 보낼 채널은 CLAUDE.md 1절 스키마에 없다(임의 추가 금지).
  // 그래서 live 메시지에서 파생 계산한다. auto 는 이 대시보드가 마지막으로 보낸
  // 명령 기준이므로, 다른 대시보드가 동시에 조작하면 표시가 어긋날 수 있다.
  let auto = true;              // 서버 기본값과 동일
  let holdElapsed = 0;
  let lastDepth = 0;            // 마지막 live 의 depth_est

  function emitState(depthEst = lastDepth) {
    const s = {
      auto,
      holdElapsed,
      holdTotal: HOLD_SECONDS,
      nextLevel: DEPTH_LEVELS.find((l) => l > depthEst + 1e-9) ?? null,
      levels: DEPTH_LEVELS
    };
    stateCbs.forEach((cb) => cb(s));
  }

  function emitLink(connected) {
    linkCbs.forEach((cb) => cb(connected));
  }

  // ── 수신 처리 ────────────────────────────────────────────────────────
  function handle(msg) {
    if (Date.now() < ignoreUntil) return;   // 연결 끊김 재현 중

    if (msg.type === 'live') {
      // status:'stale' = 라즈베리파이가 ESP32 표본을 2초 이상 못 받은 상태.
      // 오래된 값을 정상처럼 그리면 안 되므로(CLAUDE.md 6절) 콜백을 호출하지 않는다.
      // 그러면 main.js 의 마지막 수신 시각이 갱신되지 않아 stale UI 로 자동 전환된다.
      if (msg.status === 'stale') return;

      holdElapsed = msg.state === 'HOLD' ? holdElapsed + 1 : 0;
      lastDepth = Number.isFinite(msg.depth_est) ? msg.depth_est : lastDepth;
      liveCbs.forEach((cb) => cb(msg));
      emitState();
      return;
    }

    // 측정 레코드 (type 없음) — depth 는 항상 0.5|1.0|1.5
    if (typeof msg.survey === 'number' && typeof msg.depth === 'number') {
      recordCbs.forEach((cb) => cb(msg));
    }
  }

  // ── 연결 · 재연결(지수 백오프, 최대 10초) ─────────────────────────────
  // CLAUDE.md 4절: 이 로직은 절대 보존한다.
  // 재예약은 반드시 scheduleReconnect() 한 곳에서만 한다. error 와 close 는
  // 환경(브라우저/런타임)에 따라 한쪽만 오기도 하므로 양쪽에서 호출하되
  // 소켓 1개당 한 번만 예약되도록 잠근다.
  let scheduled = false;

  function scheduleReconnect(sock) {
    if (sock !== ws || scheduled) return;   // 옛 소켓의 뒤늦은 이벤트 · 중복 예약 차단
    scheduled = true;
    ws = null;
    // 핸들러를 먼저 떼어낸다. close() 가 다시 error 를 쏘는 런타임이 있어
    // 떼어내지 않으면 재귀 호출이 된다.
    sock.onopen = null; sock.onmessage = null; sock.onerror = null; sock.onclose = null;
    try { sock.close(); } catch { /* noop */ }

    emitLink(false);
    if (!running) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }

  function connect() {
    if (!running) return;
    scheduled = false;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      ws = null;
      scheduled = true;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      return;
    }
    ws = sock;

    sock.onopen = () => {
      backoff = RECONNECT_MIN_MS;     // 성공하면 백오프 초기화
      emitLink(true);
    };

    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };

    sock.onerror = () => scheduleReconnect(sock);
    sock.onclose = () => scheduleReconnect(sock);
  }

  return {
    onLive(cb) { liveCbs.push(cb); return () => liveCbs.splice(liveCbs.indexOf(cb), 1); },
    onRecord(cb) { recordCbs.push(cb); return () => recordCbs.splice(recordCbs.indexOf(cb), 1); },
    onWinchState(cb) { stateCbs.push(cb); return () => stateCbs.splice(stateCbs.indexOf(cb), 1); },
    /** 소켓 연결 여부 알림(선택) */
    onLink(cb) { linkCbs.push(cb); return () => linkCbs.splice(linkCbs.indexOf(cb), 1); },

    /** 대시보드 → 라즈베리파이 명령. 대시보드는 명령만 보낸다(CLAUDE.md 0절). */
    sendCommand(cmd) {
      if (cmd === 'auto') auto = true;
      else if (cmd === 'down' || cmd === 'stop' || cmd === 'up') auto = false;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // 끊긴 동안 쌓아두었다가 나중에 보내면 의도치 않은 시점에 윈치가 움직인다.
        console.warn('[ws-client] 연결 끊김 — 명령 취소:', cmd);
        return false;
      }
      ws.send(JSON.stringify({ cmd }));
      emitState();
      return true;
    },

    /** 연결 끊김 UI 검증용: N초 동안 수신을 무시한다(서버 프로토콜은 건드리지 않음). */
    injectStale(seconds = 4) { ignoreUntil = Date.now() + seconds * 1000; },

    start() {
      if (running) return;
      running = true;
      connect();
    },
    stop() {
      running = false;
      clearTimeout(retryTimer);
      if (ws) { try { ws.close(); } catch { /* noop */ } }
      ws = null;
    },

    get connected() { return !!ws && ws.readyState === WebSocket.OPEN; },
    url
  };
}
