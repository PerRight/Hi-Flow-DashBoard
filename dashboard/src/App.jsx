/**
 * App.jsx — 대시보드 조립부.
 *
 * 데이터 입력은 두 채널이다 (CLAUDE.md 1절) — useDashboardData 훅이 처리한다.
 *   - live 메시지(1 Hz 상시)  : 게이지·수심 패널·보트 위치 전용. 저장하지 않는다.
 *   - 측정 레코드(HOLD 구간만) : 서버가 SQLite 에 저장, 대시보드는 표시만 한다.
 *
 * 갱신 주기 (CLAUDE.md 3절)
 *   - 게이지 : 1초 (fastSeq) / 히트맵 · 지도 궤적 : 3초 배치 (batchSeq)
 *   - 전체 리렌더는 하지 않는다 — 각 패널은 자기 DOM/캔버스만 부분 갱신한다.
 *
 * 레이아웃은 라이트 테마 4열 그리드 (UI_REQUIREMENTS §1, 사용자 확정 2026-08-26).
 * 시계열 차트는 제거했다 (사용자 확정 2026-08-26, §0 미결 1번).
 * 표시 항목(EC/TDS)과 깊이 슬라이스 선택은 좌측 레일이 단독 소유한다 (§4.1).
 */
import { useEffect, useRef, useState } from 'react';
import { useDashboardData } from './hooks/useDashboardData.js';
import { SERVER, DEPTH_LEVELS, HEATMAP_3D, layerLabel } from './config.js';
import { buildStations } from './stations.js';
import SurveySelect from './components/SurveySelect.jsx';
import Rail from './components/Rail.jsx';
import DepthPanel from './components/DepthPanel.jsx';
import GaugePanel from './components/GaugePanel.jsx';
import MapPanel from './components/MapPanel.jsx';
import Heatmap3D from './components/Heatmap3D.jsx';
import SurveyPanel from './components/SurveyPanel.jsx';

const comma = (n) => n.toLocaleString('ko-KR');
const EMPTY_COUNTS = Object.fromEntries(DEPTH_LEVELS.map((d) => [d.toFixed(1), 0]));

export default function App() {
  const d = useDashboardData();

  const layoutRef = useRef(null);
  const mapRef = useRef(null);

  // 좌측 레일이 소유하는 선택 상태
  const [metric, setMetric] = useState('ec');
  const [depth, setDepth] = useState('all');
  const [counts, setCounts] = useState(EMPTY_COUNTS);

  // 히트맵과 지도가 공유하는 측정 지점 집계 — 같은 id 를 봐야 클릭이 동기화된다.
  const [agg, setAgg] = useState({ bounds: null, list: [], byId: new Map() });
  const [selected, setSelected] = useState(null);   // station id

  // 조사지 이름 — 헤더 입력란과 차수 패널이 같은 값을 본다 (2026-08-29).
  // 차수가 열려 있으면 서버가 준 이름이 정본이고, 없을 때만 사용자가 자유롭게 적는다.
  const [siteDraft, setSiteDraft] = useState('');
  useEffect(() => {
    if (d.winchMeta.surveyOpen && d.winchMeta.site) setSiteDraft(d.winchMeta.site);
  }, [d.winchMeta.surveyOpen, d.winchMeta.site]);

  // 리사이즈 대응 (지도만 명령형 — 히트맵은 자기 ResizeObserver 를 갖는다)
  useEffect(() => {
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    if (layoutRef.current) ro.observe(layoutRef.current);
    return () => ro.disconnect();
  }, []);

  // 3초 배치마다 측정 지점을 다시 접는다 (히트맵·지도 공용)
  useEffect(() => {
    setAgg(buildStations(d.recordsRef.current ?? [], metric));
  }, [d.batchSeq, d.recordsRef, metric]);

  // 사라진 지점을 계속 선택 상태로 두지 않는다 (차수 전환·항목 변경)
  useEffect(() => {
    if (selected && !agg.byId.has(selected)) setSelected(null);
  }, [agg, selected]);

  // 3초 배치마다 깊이별 레코드 수를 다시 센다 (레일 탭의 건수 표시)
  useEffect(() => {
    const next = { ...EMPTY_COUNTS };
    for (const r of d.recordsRef.current ?? []) {
      const k = Number.isFinite(r.depth) ? r.depth.toFixed(1) : null;
      if (k && k in next) next[k] += 1;
    }
    setCounts(next);
  }, [d.batchSeq, d.recordsRef]);

  const linkClass = d.stale ? 'link-status link-stale' : 'link-status link-ok';
  const linkText = d.stale
    ? (d.linkUp ? '센서 미수신 — 표시값은 마지막 수신값' : '서버 연결 끊김 — 재접속 시도 중')
    : '연결됨';

  // ── GPS 표시 (2026-09-13) ────────────────────────────────────────────────
  // 서버가 판정한 상태를 그대로 쓴다 — 대시보드가 좌표 나이를 다시 추정하지 않는다.
  // gpsState === null 이면 구버전 서버라 GPS 정보가 없다 → 아무것도 표시하지 않는다.
  const gpsAge = d.gpsRef.current.age;
  const gpsAgeText = Number.isFinite(gpsAge) ? `${Math.round(gpsAge)}초` : '';
  const GPS_VIEW = {
    ok:   { chip: '실측 GPS', warn: null, cls: 'gps-chip ok' },
    hold: { chip: `⚠ FIX 끊김 ${gpsAgeText}`, cls: 'gps-chip warn',
            warn: `GPS 신호가 ${gpsAgeText}간 끊겼습니다 — 지도의 보트 위치는 마지막으로 잡힌 좌표이며 현재 위치가 아닙니다.` },
    wait: { chip: '⚠ FIX 대기 중', cls: 'gps-chip warn',
            warn: 'GPS FIX 를 아직 못 잡았습니다 — 측정 레코드가 좌표 없이 저장되어 3D 맵핑에 올라가지 않습니다.' },
    none: { chip: '모의 좌표', cls: 'gps-chip warn',
            warn: 'GPS 가 연결되지 않았습니다 — 지도의 보트 위치는 시뮬레이션 값입니다.' }
  };
  const gpsView = d.gpsState ? GPS_VIEW[d.gpsState] ?? null : null;

  // 과거 차수를 보는 중이면 지도는 기록된 궤적이므로 회색 처리 대상이 아니다.
  // GPS 가 hold/wait 여도 보트 마커는 회색이어야 한다 — 위치 자체가 현재 값이 아니다.
  const posStale = d.stale || d.gpsState === 'hold' || d.gpsState === 'wait';
  const mapStale = posStale && d.selectedSurvey === d.activeSurveyRef.current;

  // 날짜까지 보여 준다 (사용자 확정 2026-09-02) — 조사 기록과 대조할 때 필요하다.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const clockDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  const clockTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const viewingLabel = d.surveyOptions.find((o) => o.no === d.selectedSurvey)?.label ?? '-';
  const totalCount = DEPTH_LEVELS.reduce((a, v) => a + counts[v.toFixed(1)], 0);
  const shownCount = depth === 'all' ? totalCount : counts[depth] ?? 0;
  const selectedStation = selected ? agg.byId.get(selected) : null;
  const age = d.lastLiveAtRef.current
    ? ((Date.now() - d.lastLiveAtRef.current) / 1000).toFixed(1) : '-';

  const footerText =
    `보기: ${d.selectedSurvey === null ? '차수 없음 — 차수를 시작하면 기록됩니다' : viewingLabel}` +
    ` · 측정 레코드 ${comma(totalCount)}건 ` +
    `(fault ${d.faultCountRef.current}건, 히트맵 집계 제외) · ` +
    `마지막 수신 ${age}초 전 · 측정 수심 ${DEPTH_LEVELS.map((v) => layerLabel(v)).join(' / ')} · ` +
    `서버 ${SERVER.http}`;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-title">Aqua-Flow 수질측정 대시보드</span>
          {/* 조사지 메모 — 차수를 열면 서버가 정한 이름으로 잠긴다 */}
          <input
            className="site-memo"
            list="site-options"
            value={siteDraft}
            onChange={(e) => setSiteDraft(e.target.value)}
            readOnly={d.winchMeta.surveyOpen}
            placeholder="조사 지점 메모"
            aria-label="조사 지점"
            title={d.winchMeta.surveyOpen
              ? '차수가 진행 중입니다 — 종료해야 조사지를 바꿀 수 있습니다'
              : '측정할 저수지 이름을 적어 두세요'}
          />
          {d.winchMeta.surveyOpen && (
            <span className="round-chip">{d.winchMeta.round}차 측정 중</span>
          )}
        </div>

        <div className="topbar-right">
          <label className="field">
            <span className="field-label">측정 차수</span>
            <SurveySelect options={d.surveyOptions} value={d.selectedSurvey} onChange={d.selectSurvey} />
          </label>
          <div className={linkClass}>
            <span className="dot" /><span className="link-text">{linkText}</span>
          </div>
          <div className="clock">
            <span className="clock-date">{clockDate}</span>
            <span className="clock-time num">{clockTime}</span>
          </div>
        </div>
      </header>

      {/* 오래된 값을 현재 값처럼 보이지 않게 한다 (CLAUDE.md 6절) */}
      {d.stale && (
        <div className="banner">
          ⚠ 데이터 수신이 {age}초간 없습니다 — 아래 값은 마지막 수신값이며 현재 상태가 아닙니다.
        </div>
      )}

      {/* GPS 경고 — 수질값은 정상인데 위치만 못 믿는 상황이라 주의색(노랑)이다.
          센서 자체가 끊긴 stale 이면 위 배너가 이미 전부를 덮으므로 띄우지 않는다. */}
      {!d.stale && gpsView?.warn && (
        <div className="banner caution">⚠ {gpsView.warn}</div>
      )}

      <main className="layout" ref={layoutRef}>
        <Rail
          metric={metric}
          onMetric={setMetric}
          depth={depth}
          onDepth={setDepth}
          counts={counts}
          survey={d.selectedSurvey}
        />

        <section className="panel a-heat">
          <h2 className="panel-title">
            <span>3D 맵핑 · {HEATMAP_3D.metrics[metric].label}</span>
            <span className="hint">
              {depth === 'all' ? '3층 전체' : layerLabel(depth)} · {comma(shownCount)}건
              {selectedStation
                ? ` · 선택 ${selectedStation.lat.toFixed(5)}, ${selectedStation.lon.toFixed(5)}`
                : ' · 3초 배치 갱신'}
            </span>
          </h2>
          <div className="panel-body">
            <Heatmap3D
              agg={agg}
              metric={metric}
              depth={depth}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
        </section>

        <DepthPanel
          depthSeq={d.depthSeq}
          depthMsgRef={d.depthMsgRef}
          winchMeta={d.winchMeta}
          stale={d.stale}
          onCommand={d.sendCommand}
        />

        <GaugePanel
          fastSeq={d.fastSeq}
          liveTickRef={d.liveTickRef}
          stale={d.stale}
          metric={metric}
          lastSeenText={`마지막 수신 ${age}초 전`}
        >
          <SurveyPanel
            site={siteDraft}
            onSite={setSiteDraft}
            siteOptions={d.siteOptions}
            rows={d.surveyRows}
            winchMeta={d.winchMeta}
            onStart={d.startSurvey}
            onEnd={d.endSurvey}
            stale={d.stale}
          />
        </GaugePanel>

        <section className="panel a-gps">
          <h2 className="panel-title">
            <span>GPS · 이동 궤적</span>
            {gpsView && <span className={gpsView.cls}>{gpsView.chip}</span>}
          </h2>
          <div className="panel-body no-pad">
            <MapPanel
              ref={mapRef}
              batchSeq={d.batchSeq}
              trailRef={d.trailRef}
              mapLatestRef={d.mapLatestRef}
              stale={mapStale}
              stations={agg.list}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
        </section>
      </main>

      <footer className="statusbar">
        <span>{footerText}</span>
        <span className="spacer" />
      </footer>
    </>
  );
}
