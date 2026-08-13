/**
 * panels/map.js — 위성 지도(MapLibre GL) + deck.gl 오버레이(현재 위치 · 이동 궤적).
 *
 * CLAUDE.md 3절: 지도 궤적은 3초 배치로만 갱신한다.
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

  function buildLayers() {
    const layers = [];

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
    follow(lon, lat) { map.easeTo({ center: [lon, lat], duration: 900 }); },
    basemapLabel: basemapLabel(),
    resize() { map.resize(); }
  };
}
