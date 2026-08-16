/**
 * GaugePanel.jsx — panels/gauges.js 를 감싸는 얇은 컴포넌트 (1초 갱신).
 */
import { useEffect, useRef } from 'react';
import { createGaugePanel } from '../panels/gauges.js';

export default function GaugePanel({ fastSeq, liveTickRef, stale }) {
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

  return (
    <section className="panel panel-gauges">
      <h2 className="panel-title">센서 실측값 <span className="hint">1초 갱신</span></h2>
      <div className="panel-body gauge-grid" ref={containerRef} />
    </section>
  );
}
