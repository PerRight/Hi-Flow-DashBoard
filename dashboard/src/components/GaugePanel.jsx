/**
 * GaugePanel.jsx — panels/gauges.js(240° 아크 게이지)를 감싸는 얇은 컴포넌트 (1초 갱신).
 * 게이지 형태는 기존 디자인을 그대로 채택하고 색만 라이트 테마로 바꿨다
 * (UI_REQUIREMENTS §3.7, 사용자 확정 2026-08-26).
 */
import { useEffect, useRef } from 'react';
import { createGaugePanel } from '../panels/gauges.js';
import { HEATMAP_3D } from '../config.js';

export default function GaugePanel({ fastSeq, liveTickRef, stale, metric, lastSeenText, children }) {
  const containerRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current = createGaugePanel(containerRef.current);
  }, []);

  useEffect(() => {
    if (liveTickRef.current) panelRef.current.update(liveTickRef.current);
  }, [fastSeq, liveTickRef]);

  useEffect(() => {
    panelRef.current.setStale(stale);
  }, [stale]);

  // 좌측 레일의 표시 항목 선택을 게이지에도 반영한다(선택 소유권은 레일 — §4.1).
  useEffect(() => {
    panelRef.current.setSelected(metric);
  }, [metric]);

  return (
    <section className="panel a-sensor">
      <h2 className="panel-title">
        센서 실측값 <span className="hint">1초 갱신</span>
      </h2>
      <div className="panel-body">
        <div className={`gauge-grid${stale ? ' is-stale-part' : ''}`} ref={containerRef} />
        <p className={`metric-note${stale ? ' is-stale-part' : ''}`}>
          {lastSeenText} · 표시 항목({HEATMAP_3D.metrics[metric].label}) 강조 중
        </p>
        {/* 게이지 아래 빈 자리에 조사 차수 관리를 넣는다 (사용자 요청 2026-08-29) */}
        {children}
      </div>
    </section>
  );
}
