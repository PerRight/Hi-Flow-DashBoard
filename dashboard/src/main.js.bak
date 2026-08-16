/**
 * main.js — 대시보드 조립부.
 *
 * 데이터 입력은 두 채널이다 (CLAUDE.md 1절).
 *   - client.onLive(msg)    : 1 Hz 상시. 게이지·수심 패널·시계열·보트 위치 전용. **저장하지 않는다.**
 *   - client.onRecord(rec)  : HOLD 구간에서만. 서버가 SQLite 에 저장하고 대시보드는 표시만 한다.
 * 과거 차수는 REST(GET /records?survey=N)로 가져온다.
 *
 * 갱신 주기 (CLAUDE.md 3절)
 *   - 게이지 · 시계열 : 1초
 *   - 히트맵 · 지도 궤적 : 3초 배치
 *   - 전체 리렌더는 하지 않는다. 각 패널이 자기 DOM/캔버스만 부분 갱신한다.
 */

import './style.css';
import { createWsClient, fetchSurveys, fetchRecords } from './ws-client.js';
// 개발 폴백(서버 없이 브라우저만으로 1단계처럼 돌리고 싶을 때):
//   import { createMockStream, generateHistoricalSurveys } from './mock-stream.js';
//   const client = createMockStream({ survey: 3 });
// mock-stream.js 는 이 용도로 남겨둔다(공개 API 가 ws-client 와 동일).
import {
  STALE_MS, TICK_FAST_MS, TICK_BATCH_MS, SITE, DEPTH_LEVELS, SERVER
} from './config.js';
import { createDepthPanel } from './panels/depth.js';
import { createGaugePanel } from './panels/gauges.js';
import { createChartPanel } from './panels/charts.js';
import { createMapPanel } from './panels/map.js';
import { createHeatmapPanel } from './panels/heatmap.js';

// ── 상태 저장소 (표시용 캐시. 정본은 라즈베리파이 SQLite) ──────────────────
const MAX_LIVE_RECORDS = 20000;   // 측정 레코드 기준(HOLD 구간만 쌓임). 브라우저 메모리 보호.
const MAX_TRAIL_POINTS = 3000;    // 보트 궤적 점 개수 상한
const store = new Map();          // survey(number) → records[]
const meta = new Map();           // survey(number) → { label, live }
const loaded = new Set();         // REST 로 이미 받아온 차수

let activeSurvey = null;          // 지금 기록 중인 차수 (서버가 부여)
let selectedSurvey = null;        // 화면에서 보고 있는 차수

const client = createWsClient();

// ── 패널 생성 ──────────────────────────────────────────────────────────────
document.getElementById('site-name').textContent = SITE.name;

const depthPanel = createDepthPanel(
  document.getElementById('depth-body'),
  (cmd) => client.sendCommand(cmd)          // 대시보드는 명령만 보낸다
);
const gaugePanel = createGaugePanel(document.getElementById('gauge-body'));
const chartPanel = createChartPanel();
const mapPanel = createMapPanel('map');
const heatPanel = createHeatmapPanel('heatmap', 'depth-tabs', 'heat-legend', 'heat-stats');

document.getElementById('map-basemap-hint').textContent = mapPanel.basemapLabel;

// ── 차수 선택 드롭다운 (REST) ──────────────────────────────────────────────
const surveySelect = document.getElementById('survey-select');

let surveyOptionsSig = '';
function renderSurveyOptions() {
  const html = [...meta.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, m]) => `<option value="${no}">${m.label}</option>`)
    .join('');
  if (html === surveyOptionsSig) return;   // 내용이 같으면 DOM 을 건드리지 않는다
  surveyOptionsSig = html;
  surveySelect.innerHTML = html;
  if (selectedSurvey !== null) surveySelect.value = String(selectedSurvey);
}

async function refreshSurveys() {
  const info = await fetchSurveys();
  activeSurvey = info.active;

  for (const s of info.surveys) {
    meta.set(s.survey, {
      label: s.survey === activeSurvey
        ? `${s.survey}차 (측정 중 · ${s.count}건)`
        : `${s.survey}차 (완료 · ${s.count}건)`,
      live: s.survey === activeSurvey
    });
  }
  if (!meta.has(activeSurvey)) {
    meta.set(activeSurvey, { label: `${activeSurvey}차 (측정 중)`, live: true });
  }
  if (selectedSurvey === null) selectedSurvey = activeSurvey;
  renderSurveyOptions();
  await ensureLoaded(selectedSurvey);
}

/** 차수의 누적 레코드를 REST 로 한 번만 받아온다(이후는 WebSocket 으로 이어붙임). */
async function ensureLoaded(survey) {
  if (survey === null || loaded.has(survey)) return;
  loaded.add(survey);
  let rows = [];
  try {
    rows = await fetchRecords(survey);
  } catch (e) {
    loaded.delete(survey);
    console.warn('[main] 차수 조회 실패:', survey, e);
    return;
  }
  // 조회 중에 WebSocket 으로 들어온 레코드와 겹치지 않게 병합
  const live = store.get(survey) ?? [];
  const seen = new Set(rows.map((r) => `${r.ts}|${r.depth}`));
  const merged = rows.concat(live.filter((r) => !seen.has(`${r.ts}|${r.depth}`)));
  store.set(survey, merged);
  if (survey === selectedSurvey) batchDirty = true;
}

surveySelect.addEventListener('change', async () => {
  selectedSurvey = Number(surveySelect.value);
  await ensureLoaded(selectedSurvey);
  flushBatch();
  applyStaleUi(true);
});

// ── 실시간 수신 ────────────────────────────────────────────────────────────
let lastLiveAt = 0;          // 마지막 live 수신 시각 (ms) — stale 판정 기준
let pendingLive = null;      // 이번 1초 틱에 그릴 live 메시지
let latestLive = null;       // 지도 현재 위치용 (stale 시에도 마지막 위치 유지)
let liveTrail = [];          // 보트 궤적 [[lon, lat], ...] — live 로 매초 누적
let batchDirty = true;
let staleNow = false;
let faultCount = 0;
let linkUp = false;

// ① live — 표시 전용. store 에 절대 넣지 않는다 (CLAUDE.md 1절).
//    status:'stale' 인 live 는 ws-client 가 걸러내므로 여기 도착하지 않는다.
client.onLive((msg) => {
  lastLiveAt = Date.now();
  pendingLive = msg;
  depthPanel.update(msg);          // 수심 패널은 state·depth_est 로 진행 표시

  // 보트 위치·궤적: live 의 lat/lon 을 매초 소비하고, 지도 반영은 3초 배치.
  if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
    latestLive = msg;
    const prev = liveTrail[liveTrail.length - 1];
    if (!prev || Math.abs(prev[0] - msg.lon) > 1e-7 || Math.abs(prev[1] - msg.lat) > 1e-7) {
      liveTrail.push([msg.lon, msg.lat]);
      if (liveTrail.length > MAX_TRAIL_POINTS) {
        liveTrail = liveTrail.slice(-MAX_TRAIL_POINTS);
      }
    }
    if (selectedSurvey === activeSurvey) batchDirty = true;
  }
});

// ② 측정 레코드 — HOLD 구간에서만 도착. depth 는 항상 0.5/1.0/1.5.
//    저장은 서버(SQLite)가 하고, 여기서는 화면 표시용으로만 쌓는다.
client.onRecord((rec) => {
  if (!store.has(rec.survey)) store.set(rec.survey, []);
  const list = store.get(rec.survey);
  list.push(rec);
  if (list.length > MAX_LIVE_RECORDS) list.splice(0, list.length - MAX_LIVE_RECORDS);

  // 새 차수가 시작되면(survey_start) 목록을 다시 받아온다.
  if (rec.survey !== activeSurvey) refreshSurveys().catch(() => {});

  // 과거 차수를 보고 있을 때는 배치 갱신을 돌릴 이유가 없다(불필요한 재집계 방지).
  if (selectedSurvey === rec.survey) batchDirty = true;
});

client.onWinchState((s) => depthPanel.setWinchMeta(s));
client.onLink((up) => { linkUp = up; applyStaleUi(true); });

// ── 1초 틱: 게이지 · 시계열 ────────────────────────────────────────────────
setInterval(() => {
  // 이번 1초 동안 live 를 못 받았으면 차트에는 공백(null)을 넣는다(CLAUDE.md 6절).
  chartPanel.push(pendingLive);
  chartPanel.render();
  if (pendingLive) gaugePanel.update(pendingLive);
  pendingLive = null;
  updateFooter();
}, TICK_FAST_MS);

// ── 3초 배치: 지도 궤적 · 히트맵 ───────────────────────────────────────────
function flushBatch() {
  batchDirty = false;
  const records = store.get(selectedSurvey) ?? [];

  // 히트맵: 선택 차수 전체 측정 레코드. fault 제외/수심 슬라이스는 패널이 처리.
  heatPanel.setRecords(records);
  faultCount = records.reduce((n, r) => n + (r.status === 'fault' ? 1 : 0), 0);

  if (selectedSurvey === activeSurvey) {
    // 측정 중 차수: 궤적·현재 위치는 live(1 Hz GPS)가 정본이다.
    mapPanel.setData(liveTrail, latestLive);
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
    mapPanel.setData(trail, records.length ? records[records.length - 1] : null);
  }
}
setInterval(() => { if (batchDirty) flushBatch(); }, TICK_BATCH_MS);

// ── stale 감시 (CLAUDE.md 6절: 오래된 값을 정상처럼 보이면 안 된다) ────────
const linkEl = document.getElementById('link-status');
const linkText = linkEl.querySelector('.link-text');

function applyStaleUi(force = false) {
  const age = Date.now() - lastLiveAt;
  const isStale = !linkUp || lastLiveAt === 0 || age > STALE_MS;
  if (isStale === staleNow && !force) return;
  staleNow = isStale;

  gaugePanel.setStale(isStale);
  depthPanel.setStale(isStale);
  // 과거 차수를 보는 중이라면 지도는 기록된 궤적이므로 회색 처리 대상이 아니다.
  mapPanel.setStale(isStale && selectedSurvey === activeSurvey);

  linkEl.className = `link-status ${isStale ? 'link-stale' : 'link-ok'}`;
  linkText.textContent = isStale
    ? (linkUp ? '센서 미수신 — 표시값은 마지막 수신값' : '서버 연결 끊김 — 재접속 시도 중')
    : '연결됨';
}
setInterval(applyStaleUi, 250);

// ── 하단 상태줄 · 시계 ─────────────────────────────────────────────────────
const footerEl = document.getElementById('footer-stats');
const clockEl = document.getElementById('clock');

function updateFooter() {
  clockEl.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const count = (store.get(selectedSurvey) ?? []).length;
  const age = lastLiveAt ? ((Date.now() - lastLiveAt) / 1000).toFixed(1) : '-';
  const viewing = meta.get(selectedSurvey)?.label ?? '-';
  footerEl.textContent =
    `보기: ${viewing} · 측정 레코드 ${count}건 (fault ${faultCount}건, 히트맵 집계 제외) · ` +
    `마지막 수신 ${age}초 전 · 수심 슬라이스 ${DEPTH_LEVELS.map((d) => d.toFixed(1)).join(' / ')} m · ` +
    `서버 ${SERVER.http}`;
}

document.getElementById('btn-inject-stale').addEventListener('click', () => client.injectStale(4));

// ── 리사이즈 대응 ──────────────────────────────────────────────────────────
const ro = new ResizeObserver(() => {
  mapPanel.resize();
  heatPanel.resize();
  chartPanel.resize();
});
ro.observe(document.querySelector('.layout'));

// ── 시작 ───────────────────────────────────────────────────────────────────
flushBatch();
updateFooter();
client.start();
refreshSurveys().catch((e) => console.warn('[main] 차수 목록 조회 실패:', e));
// 차수 목록은 30초마다 새로고침(다른 대시보드가 survey_start 를 보냈을 수 있다).
setInterval(() => refreshSurveys().catch(() => {}), 30000);
