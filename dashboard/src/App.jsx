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
import { SITE, SERVER, DEPTH_LEVELS, HEATMAP_3D } from './config.js';
import { basemapLabel } from './basemap.js';
import SurveySelect from './components/SurveySelect.jsx';
import Rail from './components/Rail.jsx';
import DepthPanel from './components/DepthPanel.jsx';
import GaugePanel from './components/GaugePanel.jsx';
import MapPanel from './components/MapPanel.jsx';
import Heatmap3D from './components/Heatmap3D.jsx';

const comma = (n) => n.toLocaleString('ko-KR');
const EMPTY_COUNTS = Object.fromEntries(DEPTH_LEVELS.map((d) => [d.toFixed(1), 0]));

export default function App() {
  const d = useDashboardData();

  const layoutRef = useRef(null);
  const mapRef = useRef(null);

  // 좌측 레일이 소유하는 선택 상태
  const [metric, setMetric] = useState('ec');
  const [depth, setDepth] = useState('1.0');
  const [counts, setCounts] = useState(EMPTY_COUNTS);

  // 리사이즈 대응 (지도만 명령형 — 히트맵은 자기 ResizeObserver 를 갖는다)
  useEffect(() => {
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    if (layoutRef.current) ro.observe(layoutRef.current);
    return () => ro.disconnect();
  }, []);

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

  // 과거 차수를 보는 중이면 지도는 기록된 궤적이므로 회색 처리 대상이 아니다.
  const mapStale = d.stale && d.selectedSurvey === d.activeSurveyRef.current;

  const clockText = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const viewingLabel = d.surveyOptions.find((o) => o.no === d.selectedSurvey)?.label ?? '-';
  const totalCount = DEPTH_LEVELS.reduce((a, v) => a + counts[v.toFixed(1)], 0);
  const shownCount = depth === 'all' ? totalCount : counts[depth] ?? 0;
  const age = d.lastLiveAtRef.current
    ? ((Date.now() - d.lastLiveAtRef.current) / 1000).toFixed(1) : '-';

  const footerText =
    `보기: ${viewingLabel} · 측정 레코드 ${comma(totalCount)}건 ` +
    `(fault ${d.faultCountRef.current}건, 히트맵 집계 제외) · ` +
    `마지막 수신 ${age}초 전 · 수심 슬라이스 ${DEPTH_LEVELS.map((v) => v.toFixed(1)).join(' / ')} m · ` +
    `서버 ${SERVER.http}`;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-title">수중드론 수질측정 대시보드</span>
          <span className="brand-site">{SITE.name}</span>
        </div>

        <div className="topbar-right">
          <label className="field">
            <span className="field-label">측정 차수</span>
            <SurveySelect options={d.surveyOptions} value={d.selectedSurvey} onChange={d.selectSurvey} />
          </label>
          <div className={linkClass}>
            <span className="dot" /><span className="link-text">{linkText}</span>
          </div>
          <div className="clock">{clockText}</div>
        </div>
      </header>

      {/* 오래된 값을 현재 값처럼 보이지 않게 한다 (CLAUDE.md 6절) */}
      {d.stale && (
        <div className="banner">
          ⚠ 데이터 수신이 {age}초간 없습니다 — 아래 값은 마지막 수신값이며 현재 상태가 아닙니다.
        </div>
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
            <span>3D 히트맵 · {HEATMAP_3D.metrics[metric].label}</span>
            <span className="hint">
              {depth === 'all' ? '3층 전체' : `${depth} m`} · {comma(shownCount)}건 · 3초 배치 갱신
            </span>
          </h2>
          <div className="panel-body">
            <Heatmap3D
              batchSeq={d.batchSeq}
              recordsRef={d.recordsRef}
              metric={metric}
              depth={depth}
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
        />

        <section className="panel a-gps">
          <h2 className="panel-title">
            GPS · 이동 궤적 <span className="hint">현재 위치 1초 · 궤적 3초 배치 · {basemapLabel()}</span>
          </h2>
          <div className="panel-body no-pad">
            <MapPanel
              ref={mapRef}
              batchSeq={d.batchSeq}
              trailRef={d.trailRef}
              mapLatestRef={d.mapLatestRef}
              stale={mapStale}
            />
          </div>
        </section>
      </main>

      <footer className="statusbar">
        <span>{footerText}</span>
        <span className="spacer" />
        <button
          className="mini-btn"
          title="Wi-Fi 끊김 상황을 강제로 재현합니다"
          onClick={() => d.injectStale(4)}
        >
          끊김 상황 주입(4초)
        </button>
      </footer>
    </>
  );
}
