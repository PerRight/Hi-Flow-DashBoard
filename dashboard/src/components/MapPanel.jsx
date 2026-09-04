/**
 * MapPanel.jsx — panels/map.js(MapLibre + deck.gl)를 감싸는 컴포넌트 (3초 배치).
 * 측정 지점 마커와 선택 하이라이트는 3D 히트맵과 같은 station id 로 동기화된다.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createMapPanel } from '../panels/map.js';

const MapPanel = forwardRef(function MapPanel(
  { batchSeq, trailRef, mapLatestRef, stale, stations, selected, onSelect }, ref
) {
  const panelRef = useRef(null);
  const selectCbRef = useRef(onSelect);
  selectCbRef.current = onSelect;

  useEffect(() => {
    panelRef.current = createMapPanel('map');
    // 콜백은 ref 로 감싸 등록한다 — 지도는 한 번만 만들고 다시 만들지 않는다.
    panelRef.current.onStationClick((id) => selectCbRef.current?.(id));
  }, []);

  useImperativeHandle(ref, () => ({
    resize: () => panelRef.current?.resize()
  }), []);

  useEffect(() => {
    panelRef.current?.setData(trailRef.current, mapLatestRef.current);
  }, [batchSeq, trailRef, mapLatestRef]);

  useEffect(() => {
    panelRef.current?.setStations(stations);
  }, [stations]);

  useEffect(() => {
    panelRef.current?.setSelected(selected);
  }, [selected]);

  useEffect(() => {
    panelRef.current?.setStale(stale);
  }, [stale]);

  return <div id="map" className="map-canvas" />;
});

export default MapPanel;
