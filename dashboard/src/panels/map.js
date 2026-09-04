/**
 * panels/map.js — 위성 지도(MapLibre GL) + deck.gl 오버레이(현재 위치 · 이동 궤적).
 *
 * CLAUDE.md 3절: 지도 궤적은 3초 배치로만 갱신한다.
 *
 * 측정 지점 마커(2026-08-28 추가): stations.js 가 만든 지점 목록을 그대로 받아
 * 3D 히트맵과 **같은 id** 로 그린다. 마커를 누르면 히트맵 막대가 함께 강조된다.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { SITE } from '../config.js';
import { makeBasemapStyle, basemapLabel } from '../basemap.js';

export function createMapPanel(containerId) {
  const map = new maplibregl.Map({
    container: containerId,
    style: makeBasemapStyle(),
    center: [SITE.lon, SITE.lat],
    zoom: 15.4,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-right');

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  let trail = [];        // [[lon, lat], ...]
  let current = null;    // 최신 레코드
  let staleFlag = false;
  let stations = [];     // stations.js 의 지점 목록 (히트맵과 공유)
  let selectedId = null;
  let stationClickCb = null;

  function buildLayers() {
    const layers = [];

    // 측정 지점 — 히트맵과 클릭 하이라이트를 공유한다.
    if (stations.length) {
      layers.push(new ScatterplotLayer({
        id: 'stations',
        data: stations,
        getPosition: (d) => [d.lon, d.lat],
        radiusUnits: 'pixels',
        getRadius: (d) => (d.id === selectedId ? 11 : 7),
        getFillColor: (d) => (d.id === selectedId ? [255, 212, 0, 235] : [63, 143, 203, 205]),
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: (d) => (d.id === selectedId ? 3 : 1.5),
        getLineColor: (d) => (d.id === selectedId ? [15, 43, 61] : [255, 255, 255]),
        pickable: true,
        onClick: ({ object }) => {
          if (!object || !stationClickCb) return false;
          stationClickCb(object.id === selectedId ? null : object.id);
          return true;
        },
        updateTriggers: { getRadius: selectedId, getFillColor: selectedId,
                          getLineWidth: selectedId, getLineColor: selectedId }
      }));
    }

    if (trail.length > 1) {
      layers.push(new PathLayer({
        id: 'boat-trail',
        data: [{ path: trail }],
        getPath: (d) => d.path,
        getColor: staleFlag ? [130, 140, 150] : [56, 189, 248],
        getWidth: 3,
        widthUnits: 'pixels',
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
        pickable: false
      }));
    }

    if (current) {
      layers.push(new ScatterplotLayer({
        id: 'boat-halo',
        data: [current],
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 14,
        radiusUnits: 'pixels',
        getFillColor: staleFlag ? [120, 130, 140, 70] : [56, 189, 248, 70],
        pickable: false
      }));
      layers.push(new ScatterplotLayer({
        id: 'boat-current',
        data: [current],
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: staleFlag ? [150, 160, 170] : [255, 255, 255],
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        getLineColor: staleFlag ? [90, 100, 110] : [14, 20, 24],
        pickable: true
      }));
    }
    return layers;
  }

  function refresh() {
    overlay.setProps({ layers: buildLayers() });
  }

  return {
    map,
    /** 3초 배치로 호출: 궤적 좌표 배열과 최신 레코드를 통째로 교체 */
    setData(trailPoints, latest) {
      trail = trailPoints;
      current = latest;
      refresh();
    },
    setStale(isStale) {
      if (staleFlag === isStale) return;
      staleFlag = isStale;
      refresh();
    },
    /** 3초 배치로 호출: 측정 지점 목록 교체 (stations.js 결과 그대로) */
    setStations(list) {
      stations = list ?? [];
      refresh();
    },
    /** 선택된 지점 id — 히트맵 클릭으로도 바뀐다 */
    setSelected(id) {
      if (selectedId === id) return;
      selectedId = id;
      refresh();
    },
    onStationClick(cb) { stationClickCb = cb; },
    follow(lon, lat) { map.easeTo({ center: [lon, lat], duration: 900 }); },
    basemapLabel: basemapLabel(),
    resize() { map.resize(); }
  };
}
