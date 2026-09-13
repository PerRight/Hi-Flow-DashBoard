/**
 * useDashboardData.js — 기존 main.js의 상태 로직을 React 훅으로 이식한 것.
 *
 * 원본 main.js는 모듈 스코프 변수(let store, let selectedSurvey, ...)와
 * setInterval 세 개(1초/3초/250ms)로 구성돼 있었다. 여기서는 같은 구조를
 * useRef(변경돼도 리렌더가 필요 없는 값)와 useState(화면에 보여야 하는 값)로
 * 그대로 옮긴다 — 로직을 새로 설계하지 않는다(CLAUDE.md 3절).
 *
 * 패널(panels/*.js)은 리렌더당하지 않고 ref로 직접 데이터를 받아 자기 DOM만
 * 갱신한다. 그래서 fastSeq/depthSeq/batchSeq 라는 "이번 틱에 갱신할 차례"
 * 신호만 증가시키고, 실제 값은 ref 스냅샷(liveTickRef 등)에 담아 컴포넌트가
 * 직접 읽게 한다 — React state 값 자체를 패널에 넘기면 참조 비교 때문에
 * "값은 그대로인데 한 틱을 건너뛰는" 문제(특히 차트의 공백 처리)가 생긴다.
 *
 * ws-client.js(재연결 로직)와 config.js(상수)는 그대로 가져다 쓴다(CLAUDE.md 4절).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createWsClient, fetchSurveys, fetchRecords, fetchSites } from '../ws-client.js';
import { STALE_MS, TICK_FAST_MS, TICK_BATCH_MS, HOLD_SECONDS } from '../config.js';

const MAX_LIVE_RECORDS = 20000;   // 측정 레코드 기준(HOLD 구간만 쌓임). 브라우저 메모리 보호.
const MAX_TRAIL_POINTS = 3000;    // 보트 궤적 점 개수 상한

export function useDashboardData() {
  // ── 표시용 캐시 (정본은 라즈베리파이 SQLite) ────────────────────────────
  const storeRef = useRef(new Map());        // survey(number) → records[]
  const metaRef = useRef(new Map());         // survey(number) → { label, live }
  const loadedRef = useRef(new Set());       // REST 로 이미 받아온 차수
  const surveyOptionsSigRef = useRef('');    // 불필요한 select 리렌더 방지용 시그니처

  const activeSurveyRef = useRef(null);      // 지금 기록 중인 차수 (서버가 부여)
  const selectedSurveyRef = useRef(null);    // 화면에서 보고 있는 차수 (콜백에서 최신값 참조용)

  const [selectedSurvey, setSelectedSurveyState] = useState(null);
  const [surveyOptions, setSurveyOptions] = useState([]); // [{no, label}]
  // 조사지·차수 (2026-08-29) — 차수는 조작자가 열어야 생긴다.
  const [siteOptions, setSiteOptions] = useState([]);     // 최근에 쓴 조사지 이름
  const [surveyRows, setSurveyRows] = useState([]);       // /surveys 원본 행

  // ── 실시간 수신 ──────────────────────────────────────────────────────────
  const lastLiveAtRef = useRef(0);           // 마지막 live 수신 시각(ms) — stale 판정 기준
  const pendingLiveRef = useRef(null);       // 이번 1초 구간에 들어온 마지막 live (누적기)
  const liveTickRef = useRef(null);          // 1초 틱 시점의 스냅샷 — 차트·게이지가 읽는다
  const depthMsgRef = useRef(null);          // 수심 패널용 — live 수신 즉시 갱신(배치 없음)
  const latestLiveRef = useRef(null);        // 지도 현재 위치용 (stale 에도 마지막 위치 유지)
  const liveTrailRef = useRef([]);           // 보트 궤적 [[lon, lat], ...]
  // 궤적 생명주기 (사용자 확정 2026-09-06):
  //   지점 이동 중(측정 전)에만 궤적을 그린다.
  //   측정 시작 → 그리기 중지 / 측정 완료 → 직전 구간(A→B) 궤적을 지우고
  //   현재 위치에서 다음 구간(B→C)을 새로 그리기 시작한다.
  const measuringRef = useRef(false);
  const batchDirtyRef = useRef(true);
  const faultCountRef = useRef(0);

  const recordsRef = useRef([]);             // 히트맵: 선택 차수의 측정 레코드
  const trailRef = useRef([]);               // 지도: 궤적
  const mapLatestRef = useRef(null);         // 지도: 최신 위치

  const linkUpRef = useRef(false);
  const clientRef = useRef(null);

  const [fastSeq, setFastSeq] = useState(0);     // 1초 틱 (게이지·시계열·시계·하단바)
  const [depthSeq, setDepthSeq] = useState(0);   // live 수신마다 증가 (수심 패널)
  const [batchSeq, setBatchSeq] = useState(0);   // 3초 배치 (지도·히트맵)
  const [winchMeta, setWinchMeta] = useState({
    measuring: false, holdElapsed: 0, holdTotal: HOLD_SECONDS, holdDone: false,
    nextLevel: null, levels: [],
    surveyOpen: false, survey: null, site: null, round: null, surveyDate: null,
    mirror: false,         // 원격(클라우드 미러) 화면인가 — 헤더 표시용
    control: true          // 명령이 라즈베리파이까지 갈 수 있는가 (2026-09-13)
  });
  const [stale, setStale] = useState(false);
  const [linkUp, setLinkUp] = useState(false);
  // GPS 표시 상태 (2026-09-13). 'ok' | 'hold' | 'wait' | 'none' | null(구버전 서버).
  // 초 단위 나이는 1초마다 바뀌므로 ref 에 둔다 — 이것 때문에 앱 전체를 다시
  // 그리지 않는다 (CLAUDE.md 3절). 상태 문자열이 바뀔 때만 리렌더한다.
  const gpsRef = useRef({ state: null, age: null });
  const [gpsState, setGpsState] = useState(null);

  useEffect(() => { selectedSurveyRef.current = selectedSurvey; }, [selectedSurvey]);

  // ── 차수 드롭다운 (내용이 같으면 state 를 건드리지 않는다 — 원본과 동일한 최적화) ──
  const renderSurveyOptions = useCallback(() => {
    const entries = [...metaRef.current.entries()].sort((a, b) => a[0] - b[0]);
    const sig = entries.map(([no, m]) => `${no}:${m.label}`).join('|');
    if (sig === surveyOptionsSigRef.current) return;
    surveyOptionsSigRef.current = sig;
    setSurveyOptions(entries.map(([no, m]) => ({ no, label: m.label })));
  }, []);

  // ── 3초 배치: 히트맵 레코드 · 지도 궤적/현재 위치 ──────────────────────────
  const flushBatch = useCallback(() => {
    batchDirtyRef.current = false;
    const survey = selectedSurveyRef.current;
    const records = storeRef.current.get(survey) ?? [];
    recordsRef.current = records;
    faultCountRef.current = records.reduce((n, r) => n + (r.status === 'fault' ? 1 : 0), 0);

    if (survey === activeSurveyRef.current) {
      // 측정 중 차수: 궤적·현재 위치는 live(1 Hz GPS)가 정본이다.
      trailRef.current = liveTrailRef.current;
      mapLatestRef.current = latestLiveRef.current;
    } else {
      // 과거 차수: 기록된 측점 경로.
      const trail = [];
      let prev = null;
      for (const r of records) {
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
        if (prev && Math.abs(prev[0] - r.lon) < 1e-7 && Math.abs(prev[1] - r.lat) < 1e-7) continue;
        prev = [r.lon, r.lat];
        trail.push(prev);
      }
      trailRef.current = trail;
      mapLatestRef.current = records.length ? records[records.length - 1] : null;
    }
    setBatchSeq((s) => s + 1);
  }, []);

  /** 차수의 누적 레코드를 REST 로 한 번만 받아온다(이후는 WebSocket 으로 이어붙임). */
  const ensureLoaded = useCallback(async (survey) => {
    if (survey === null || loadedRef.current.has(survey)) return;
    loadedRef.current.add(survey);
    let rows = [];
    try {
      rows = await fetchRecords(survey);
    } catch (e) {
      loadedRef.current.delete(survey);
      console.warn('[useDashboardData] 차수 조회 실패:', survey, e);
      return;
    }
    const live = storeRef.current.get(survey) ?? [];
    const seen = new Set(rows.map((r) => `${r.ts}|${r.depth}`));
    const merged = rows.concat(live.filter((r) => !seen.has(`${r.ts}|${r.depth}`)));
    storeRef.current.set(survey, merged);
    if (survey === selectedSurveyRef.current) batchDirtyRef.current = true;
  }, []);

  const refreshSurveys = useCallback(async () => {
    const info = await fetchSurveys();
    // active 는 "열려 있는 차수" 다. 아무 차수도 열지 않았으면 null 이다
    // (전원만 켜져 있다고 차수가 생기지 않는다 — 사용자 확정 2026-08-29).
    activeSurveyRef.current = info.active_recording ? info.active : null;
    setSurveyRows(info.surveys ?? []);

    for (const s of info.surveys ?? []) {
      const open = s.ended_at === null || s.ended_at === undefined;
      const md = (s.survey_date ?? '').slice(5).replace('-', '/');
      metaRef.current.set(s.survey, {
        label: `${s.site} ${md} ${s.round}차 (${open ? '측정 중' : '완료'} · ${s.count}건)`,
        live: open
      });
    }
    // 처음 열었을 때: 진행 중 차수가 있으면 그것을, 없으면 가장 최근 차수를 본다.
    if (selectedSurveyRef.current === null && (info.surveys ?? []).length) {
      const pick = info.active_recording
        ? info.active
        : info.surveys[info.surveys.length - 1].survey;
      selectedSurveyRef.current = pick;
      setSelectedSurveyState(pick);
    }
    renderSurveyOptions();
    if (selectedSurveyRef.current !== null) await ensureLoaded(selectedSurveyRef.current);
  }, [ensureLoaded, renderSurveyOptions]);

  const refreshSites = useCallback(async () => {
    try { setSiteOptions(await fetchSites()); } catch { /* 목록은 없어도 된다 */ }
  }, []);

  // ── stale 감시 (CLAUDE.md 6절: 오래된 데이터를 정상처럼 보이면 안 된다) ──────
  const recomputeStale = useCallback((force = false) => {
    const age = Date.now() - lastLiveAtRef.current;
    const isStale = !linkUpRef.current || lastLiveAtRef.current === 0 || age > STALE_MS;
    setStale((prev) => (prev === isStale && !force ? prev : isStale));
  }, []);

  const selectSurvey = useCallback((no) => {
    selectedSurveyRef.current = no;
    setSelectedSurveyState(no);
    ensureLoaded(no).then(() => {
      flushBatch();
      recomputeStale(true);
    });
  }, [ensureLoaded, flushBatch, recomputeStale]);

  const sendCommand = useCallback((cmd, extra) => clientRef.current?.sendCommand(cmd, extra), []);

  /** 차수 열기 — 조사지 이름이 있어야 한다. 차수 번호는 서버가 조사지+날짜로 정한다. */
  const startSurvey = useCallback(async (site, memo) => {
    const name = (site ?? '').trim();
    if (!name) return false;
    const ok = clientRef.current?.sendCommand('survey_start', { site: name, memo });
    if (!ok) return false;
    await new Promise((r) => setTimeout(r, 400));    // 서버가 surveys 에 넣을 시간
    await refreshSurveys().catch(() => {});
    await refreshSites();
    // 새로 연 차수를 바로 보게 한다
    const info = await fetchSurveys().catch(() => null);
    if (info?.active_recording) {
      selectedSurveyRef.current = info.active;
      setSelectedSurveyState(info.active);
      await ensureLoaded(info.active);
      flushBatch();
    }
    return true;
  }, [ensureLoaded, flushBatch, refreshSites, refreshSurveys]);

  /** 차수 닫기 — 진행 중이던 측정은 버려진다(30초 미만은 기록하지 않는다). */
  const endSurvey = useCallback(async () => {
    clientRef.current?.sendCommand('survey_end');
    await new Promise((r) => setTimeout(r, 400));
    await refreshSurveys().catch(() => {});
  }, [refreshSurveys]);

  useEffect(() => {
    const client = createWsClient();
    clientRef.current = client;

    // ① live — 표시 전용. store 에 절대 넣지 않는다 (CLAUDE.md 1절).
    client.onLive((msg) => {
      lastLiveAtRef.current = Date.now();
      pendingLiveRef.current = msg;
      depthMsgRef.current = msg;         // 수심 패널은 매 live 마다 즉시 반영
      setDepthSeq((s) => s + 1);

      // GPS 표시 상태 — 키가 없는 구버전 서버에 붙으면 null 로 두어 경고를 띄우지 않는다.
      const gs = typeof msg.gps === 'string' ? msg.gps : null;
      gpsRef.current = { state: gs, age: Number.isFinite(msg.gps_age) ? msg.gps_age : null };
      setGpsState((prev) => (prev === gs ? prev : gs));

      if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        latestLiveRef.current = msg;
        // 측정 중(측정 시작~완료)에는 궤적을 늘리지 않는다 — 보트가 그 자리에 머무는 구간이다.
        if (!measuringRef.current) {
          const trail = liveTrailRef.current;
          const prev = trail[trail.length - 1];
          if (!prev || Math.abs(prev[0] - msg.lon) > 1e-7 || Math.abs(prev[1] - msg.lat) > 1e-7) {
            trail.push([msg.lon, msg.lat]);
            if (trail.length > MAX_TRAIL_POINTS) liveTrailRef.current = trail.slice(-MAX_TRAIL_POINTS);
          }
        }
        if (selectedSurveyRef.current === activeSurveyRef.current) batchDirtyRef.current = true;
      }
    });

    // ② 측정 레코드 — HOLD 구간에서만 도착. depth 는 항상 0.5/1.0/1.5.
    client.onRecord((rec) => {
      if (!storeRef.current.has(rec.survey)) storeRef.current.set(rec.survey, []);
      const list = storeRef.current.get(rec.survey);
      list.push(rec);
      if (list.length > MAX_LIVE_RECORDS) list.splice(0, list.length - MAX_LIVE_RECORDS);

      if (rec.survey !== activeSurveyRef.current) refreshSurveys().catch(() => {});
      if (selectedSurveyRef.current === rec.survey) batchDirtyRef.current = true;
    });

    client.onWinchState((s) => {
      const was = measuringRef.current;
      measuringRef.current = !!s.measuring;
      // 측정 완료 순간(측정 중 → 아님): 직전 구간 궤적을 버리고 현재 위치에서 다시 시작한다.
      if (was && !measuringRef.current) {
        const here = latestLiveRef.current;
        liveTrailRef.current =
          here && Number.isFinite(here.lat) && Number.isFinite(here.lon)
            ? [[here.lon, here.lat]]
            : [];
        batchDirtyRef.current = true;
      }
      setWinchMeta(s);
    });
    client.onLink((up) => {
      linkUpRef.current = up;
      setLinkUp(up);
      recomputeStale(true);
    });

    // ── 1초 틱: 게이지 · 시계열 · 시계 · 하단바 ───────────────────────────
    const fastTimer = setInterval(() => {
      // 이번 1초 동안 live 를 못 받았으면 스냅샷은 null → 차트에는 공백이 들어간다(CLAUDE.md 6절).
      liveTickRef.current = pendingLiveRef.current;
      pendingLiveRef.current = null;
      setFastSeq((s) => s + 1);
    }, TICK_FAST_MS);

    // ── 3초 배치: 지도 궤적 · 히트맵 ───────────────────────────────────────
    const batchTimer = setInterval(() => {
      if (batchDirtyRef.current) flushBatch();
    }, TICK_BATCH_MS);

    const staleTimer = setInterval(() => recomputeStale(false), 250);
    // 차수 목록은 30초마다 새로고침(다른 대시보드가 survey_start 를 보냈을 수 있다).
    const surveyTimer = setInterval(() => refreshSurveys().catch(() => {}), 30000);

    flushBatch();
    client.start();
    refreshSurveys().catch((e) => console.warn('[useDashboardData] 차수 목록 조회 실패:', e));
    refreshSites();

    return () => {
      clearInterval(fastTimer);
      clearInterval(batchTimer);
      clearInterval(staleTimer);
      clearInterval(surveyTimer);
      client.stop();
    };
    // 마운트 시 1회만 — 내부에서 쓰는 콜백들은 전부 ref 기반이라 최신값을 참조한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // 차수
    selectedSurvey,
    surveyOptions,
    surveyRows,
    siteOptions,
    selectSurvey,
    startSurvey,
    endSurvey,
    activeSurveyRef,
    storeRef,
    // 명령
    sendCommand,
    // 연결 상태
    stale,
    linkUp,
    gpsState,
    gpsRef,
    // 틱 신호 + 스냅샷 ref (패널이 직접 읽는다)
    fastSeq,
    depthSeq,
    batchSeq,
    liveTickRef,
    depthMsgRef,
    recordsRef,
    trailRef,
    mapLatestRef,
    faultCountRef,
    lastLiveAtRef,
    winchMeta
  };
}
