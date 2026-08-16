/**
 * ChartPanel.jsx — panels/charts.js 를 감싸는 컴포넌트 (1초 갱신).
 * resize()는 부모(App)의 ResizeObserver 가 ref 로 직접 호출한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createChartPanel } from '../panels/charts.js';

const ChartPanel = forwardRef(function ChartPanel({ fastSeq, liveTickRef }, ref) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current = createChartPanel();
  }, []);

  useImperativeHandle(ref, () => ({
    resize: () => panelRef.current?.resize()
  }), []);

  useEffect(() => {
    // 이번 틱에 live 가 없었으면 null 이 들어간다 — 차트는 공백으로 남긴다(CLAUDE.md 6절).
    panelRef.current.push(liveTickRef.current);
    panelRef.current.render();
  }, [fastSeq, liveTickRef]);

  return (
    <section className="panel panel-chart">
      <h2 className="panel-title">최근 5분 시계열 <span className="hint">1초 갱신</span></h2>
      <div className="panel-body chart-grid">
        <div className="chart-cell"><canvas id="chart-ec" /></div>
        <div className="chart-cell"><canvas id="chart-tds" /></div>
        <div className="chart-cell"><canvas id="chart-temp" /></div>
      </div>
    </section>
  );
});

export default ChartPanel;
