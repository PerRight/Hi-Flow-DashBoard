/**
 * App.jsx — 대시보드 조립부 (기존 main.js 대체).
 *
 * 데이터 입력은 두 채널이다 (CLAUDE.md 1절) — useDashboardData 훅이 처리한다.
 *   - live 메시지(1 Hz 상시)    : 게이지·수심 패널·시계열·보트 위치 전용. 저장하지 않는다.
 *   - 측정 레코드(HOLD 구간만)   : 서버가 SQLite 에 저장, 대시보드는 표시만 한다.
 *
 * 갱신 주기 (CLAUDE.md 3절)
 *   - 게이지 · 시계열 : 1초 (fastSeq)
 *   - 히트맵 · 지도 궤적 : 3초 배치 (batchSeq)
 *   - 전체 리렌더는 하지 않는다 — 각 패널은 자기 DOM/캔버스만 부분 갱신한다.
 */
import { useEffect, useRef } from 'react';
import { useDashboardData } from './hooks/useDashboardData.js';
import { SITE, SERVER, DEPTH_LEVELS } from './config.js';
import { basemapLabel } from './basemap.js';
import SurveySelect from './components/SurveySelect.jsx';
import DepthPanel from './components/DepthPanel.jsx';
import GaugePanel from './components/GaugePanel.jsx';
import ChartPanel from './components/ChartPanel.jsx';
import MapPanel from './components/MapPanel.jsx';
import HeatmapPanel from './components/HeatmapPanel.jsx';

export default function App() {
  const d = useDashboardData();

  const layoutRef = useRef(null);
  const chartRef = useRef(null);
  const mapRef = useRef(null);
  const heatRef = useRef(null);

  // 리사이즈 대응 (원본 main.js 의 ResizeObserver 그대로)
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      mapRef.current?.resize();
      heatRef.current?.resize();
      chartRef.current?.resize();
    });
    if (layoutRef.current) ro.observe(layoutRef.current);
    return () => ro.disconnect();
  }, []);

  const linkClass = d.stale ? 'link-status link-stale' : 'link-status link-ok';
  const linkText = d.stale
    ? (d.linkUp ? '센서 미수신 — 표시값은 마지막 수신값' : '서버 연결 끊김 — 재접속 시도 중')
    : '연결됨';

  // 과거 차수를 보는 중이면 지도는 기록된 궤적이므로 회색 처리 대상이 아니다(원본 로직 동일).
  const mapStale = d.stale && d.selectedSurvey === d.activeSurveyRef.current;

  const clockText = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const viewingLabel = d.surveyOptions.find((o) => o.no === d.selectedSurvey)?.label ?? '-';
  const count = (d.storeRef.current.get(d.selectedSurvey) ?? []).length;
  const age = d.lastLiveAtRef.current ? ((Date.now() - d.lastLiveAtRef.current) / 1000).toFixed(1) : '-';
  const footerText =
    `보기: ${viewingLabel} · 측정 레코드 ${count}건 (fault ${d.faultCountRef.current}건, 히트맵 집계 제외) · ` +
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

      <main className="layout" ref={layoutRef}>
        <DepthPanel
          depthSeq={d.depthSeq}
          depthMsgRef={d.depthMsgRef}
          winchMeta={d.winchMeta}
          stale={d.stale}
          onCommand={d.sendCommand}
        />

        <GaugePanel fastSeq={d.fastSeq} liveTickRef={d.liveTickRef} stale={d.stale} />

        <section className="panel panel-map">
          <h2 className="panel-title">
            위치 · 이동 궤적 <span className="hint">{basemapLabel()}</span>
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

        <ChartPanel ref={chartRef} fastSeq={d.fastSeq} liveTickRef={d.liveTickRef} />

        <section className="panel panel-heat">
          <h2 className="panel-title">
            수질 3D 히트맵 <span className="hint">3초 배치 갱신</span>
          </h2>
          <HeatmapPanel ref={heatRef} batchSeq={d.batchSeq} recordsRef={d.recordsRef} />
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
