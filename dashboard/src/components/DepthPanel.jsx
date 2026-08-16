/**
 * DepthPanel.jsx — panels/depth.js 를 감싸는 얇은 컴포넌트.
 * 실제 렌더링·상태는 전부 depth.js 가 갖고 있다(전체 리렌더 금지 원칙 유지).
 * 이 컴포넌트는 "언제 마운트하고 언제 update()를 호출할지"만 결정한다.
 */
import { useEffect, useRef } from 'react';
import { createDepthPanel } from '../panels/depth.js';

export default function DepthPanel({ depthSeq, depthMsgRef, winchMeta, stale, onCommand }) {
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

  return (
    <section className="panel panel-depth" id="panel-depth">
      <h2 className="panel-title">현재 수심</h2>
      <div className="panel-body" ref={containerRef} />
    </section>
  );
}
