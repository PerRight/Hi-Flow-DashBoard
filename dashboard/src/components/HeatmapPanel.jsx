/**
 * HeatmapPanel.jsx — panels/heatmap.js(deck.gl GridLayer)를 감싸는 컴포넌트 (3초 배치).
 * 깊이 탭(0.5/1.0/1.5m) 전환은 heatmap.js 내부에서 즉시 처리한다(배치 주기와 무관, 원본 그대로).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createHeatmapPanel } from '../panels/heatmap.js';

const HeatmapPanel = forwardRef(function HeatmapPanel({ batchSeq, recordsRef }, ref) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current = createHeatmapPanel('heatmap', 'depth-tabs', 'heat-legend', 'heat-stats');
  }, []);

  useImperativeHandle(ref, () => ({
    resize: () => panelRef.current?.resize()
  }), []);

  useEffect(() => {
    panelRef.current?.setRecords(recordsRef.current);
  }, [batchSeq, recordsRef]);

  return (
    <>
      <div className="depth-tabs" id="depth-tabs" />
      <div className="panel-body no-pad heat-wrap">
        <div id="heatmap" className="map-canvas" />
        <div className="heat-legend" id="heat-legend" />
        <div className="heat-stats" id="heat-stats" />
      </div>
    </>
  );
});

export default HeatmapPanel;
