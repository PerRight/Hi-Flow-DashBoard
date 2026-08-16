/**
 * MapPanel.jsx — panels/map.js(MapLibre + deck.gl)를 감싸는 컴포넌트 (3초 배치).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createMapPanel } from '../panels/map.js';

const MapPanel = forwardRef(function MapPanel({ batchSeq, trailRef, mapLatestRef, stale }, ref) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current = createMapPanel('map');
  }, []);

  useImperativeHandle(ref, () => ({
    resize: () => panelRef.current?.resize()
  }), []);

  useEffect(() => {
    panelRef.current?.setData(trailRef.current, mapLatestRef.current);
  }, [batchSeq, trailRef, mapLatestRef]);

  useEffect(() => {
    panelRef.current?.setStale(stale);
  }, [stale]);

  return <div id="map" className="map-canvas" />;
});

export default MapPanel;
