/**
 * DepthPanel.jsx — panels/depth.js 를 감싸는 얇은 컴포넌트.
 * 실제 렌더링·상태는 전부 depth.js 가 갖고 있다(전체 리렌더 금지 원칙 유지).
 * 수직 물기둥 게이지는 기존 디자인을 그대로 채택, 색만 라이트 테마 (UI_REQUIREMENTS §3.8).
 */
import { useEffect, useRef } from 'react';
import { createDepthPanel } from '../panels/depth.js';

export default function DepthPanel({ depthSeq, depthMsgRef, winchMeta, stale, onCommand,
                                     readOnly = false }) {
  const containerRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current = createDepthPanel(containerRef.current, onCommand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (depthMsgRef.current) panelRef.current.update(depthMsgRef.current);
  }, [depthSeq, depthMsgRef]);

  useEffect(() => {
    panelRef.current.setWinchMeta(winchMeta);
  }, [winchMeta]);

  useEffect(() => {
    panelRef.current.setStale(stale);
  }, [stale]);

  useEffect(() => {
    panelRef.current.setReadOnly(readOnly);
  }, [readOnly]);

  return (
    <section className="panel a-depth" id="panel-depth">
      <h2 className="panel-title">
        현재 수심
      </h2>
      <div className="panel-body" ref={containerRef} />
    </section>
  );
}
