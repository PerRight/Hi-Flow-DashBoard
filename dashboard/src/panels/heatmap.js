/**
 * panels/heatmap.js — EC 3D 히트맵 (deck.gl GridLayer), 깊이 0.5/1.0/1.5 m 3개 탭 슬라이스.
 *
 * CLAUDE.md 1절 준수 사항
 *  - 컬러 도메인은 [100, 280] 고정. 280 초과는 전용 경고색(짙은 자주)으로 별도 표시.
 *  - 막대 높이(elevation)는 실측값에 정비례. 값을 왜곡하는 확대 금지.
 *  - fault 레코드는 집계에서 제외(6절). 단, 원자료에서 지우지는 않는다.
 *
 * 색 구현 방식:
 *   GridLayer 의 quantize 컬러 스케일은 (domainMax-domainMin)/colorRange.length 폭으로 균등 분할한다.
 *   폭을 30 µS/cm 로 고정하고 도메인을 [100, 730] 으로 두면
 *     버킷 1~6  → 100~280  (정상 6단계 팔레트, 즉 컬러 도메인 [100,280] 고정)
 *     버킷 7~20 → 280~700  (주의: 짙은 자주 단색)
 *     버킷 21   → 700 초과 (위험: 더 짙은 자주, 상한 클램프)
 *   이렇게 하면 별도 수동 집계 없이 GridLayer 하나로 요구사항을 모두 만족한다.
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GridLayer } from '@deck.gl/aggregation-layers';
import { SITE, HEATMAP, DEPTH_LEVELS, isAggregatable } from '../config.js';
import { makeBasemapStyle } from '../basemap.js';

const BUCKET = (HEATMAP.colorDomain[1] - HEATMAP.colorDomain[0]) / HEATMAP.colorRange.length; // 30
const DANGER_MIN = 700;

/** 정상 6색 + 주의(짙은 자주) 반복 + 위험(더 짙은 자주) 1칸 */
function buildColorRange() {
  const range = [...HEATMAP.colorRange];
  const cautionBuckets = Math.round((DANGER_MIN - HEATMAP.colorDomain[1]) / BUCKET); // 14
  for (let i = 0; i < cautionBuckets; i++) range.push(HEATMAP.overColor);
  range.push(HEATMAP.dangerColor);
  return range;
}
const COLOR_RANGE = buildColorRange();
const COLOR_DOMAIN = [HEATMAP.colorDomain[0], HEATMAP.colorDomain[0] + BUCKET * COLOR_RANGE.length];
const ELEV_MAX = 800;

export function createHeatmapPanel(containerId, tabsId, legendId, statsId) {
  const map = new maplibregl.Map({
    container: containerId,
    style: makeBasemapStyle(),
    center: [SITE.lon, SITE.lat],
    zoom: 14.7,
    pitch: 55,
    bearing: -22,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  const overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
    getTooltip: ({ object }) => {
      if (!object) return null;
      // deck.gl 버전/집계 방식(GPU·CPU)에 따라 picking 결과 형태가 달라 방어적으로 읽는다.
      const pts = object.points;
      const vals = Array.isArray(pts)
        ? pts.map((p) => (p && p.source ? p.source.ec : p && p.ec)).filter(Number.isFinite)
        : [];
      const count = object.count ?? vals.length;
      const mean = vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : object.value ?? object.colorValue;
      if (!Number.isFinite(mean)) return null;
      const extra = vals.length
        ? `<br/>최소 ${Math.min(...vals).toFixed(1)} / 최대 ${Math.max(...vals).toFixed(1)}`
        : '';
      return {
        html: `<div style="font-size:12px;line-height:1.5">
                 <b>평균 EC ${mean.toFixed(1)} µS/cm</b><br/>표본 ${count}건${extra}
               </div>`,
        style: { background: '#151d23', color: '#dbe6ee', border: '1px solid #26333d',
                 borderRadius: '6px', padding: '6px 8px' }
      };
    }
  });
  map.addControl(overlay);

  // ── 깊이 탭 ────────────────────────────────────────────────────────────
  const tabs = document.getElementById(tabsId);
  let activeDepth = DEPTH_LEVELS[0];
  tabs.innerHTML = DEPTH_LEVELS
    .map((d, i) => `<button data-depth="${d}" class="${i === 0 ? 'active' : ''}">${d.toFixed(1)} m</button>`)
    .join('');
  let depthChangeCb = null;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-depth]');
    if (!btn) return;
    activeDepth = Number(btn.dataset.depth);
    [...tabs.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    render();                       // 탭 전환은 즉시 반영 (배치 주기와 무관)
    if (depthChangeCb) depthChangeCb(activeDepth);
  });

  // ── 범례 ──────────────────────────────────────────────────────────────
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  document.getElementById(legendId).innerHTML = `
    <div class="legend-title">EC (µS/cm) · 컬러 도메인 100~280 고정</div>
    <div class="legend-bar">${HEATMAP.colorRange.map((c) => `<i style="background:${rgb(c)}"></i>`).join('')}</div>
    <div class="legend-scale"><span>100</span><span>190</span><span>280</span></div>
    <div class="legend-extra">
      <span class="legend-swatch" style="background:${rgb(HEATMAP.overColor)}"></span>
      <span>280 초과 (주의)</span>
    </div>
    <div class="legend-extra">
      <span class="legend-swatch" style="background:${rgb(HEATMAP.dangerColor)}"></span>
      <span>700 초과 (위험)</span>
    </div>
    <div class="legend-extra"><span style="color:#8598a6">막대 높이 = 평균 EC 비례</span></div>`;

  const statsEl = document.getElementById(statsId);
  let allRecords = [];

  function render() {
    // fault 제외 + 선택한 수심만 (CLAUDE.md 6절 · 3절)
    // 측정 레코드의 depth 는 항상 0.5/1.0/1.5 중 하나이므로(1절) 정확 일치로 거른다.
    const total = allRecords.filter((r) => r.depth === activeDepth);
    const data = total.filter(isAggregatable);
    const excluded = total.length - data.length;

    const layer = new GridLayer({
      id: `ec-grid-${activeDepth}`,
      data,
      pickable: true,
      extruded: true,
      cellSize: HEATMAP.cellSize,
      coverage: 0.92,
      getPosition: (d) => [d.lon, d.lat],

      // 색: 평균 EC
      colorAggregation: 'MEAN',
      getColorWeight: (d) => d.ec,
      colorScaleType: 'quantize',
      colorDomain: COLOR_DOMAIN,
      colorRange: COLOR_RANGE,

      // 높이: 평균 EC 에 정비례 (도메인=레인지 → 항등 선형, 왜곡 없음)
      elevationAggregation: 'MEAN',
      getElevationWeight: (d) => d.ec,
      elevationScaleType: 'linear',
      elevationDomain: [0, ELEV_MAX],
      elevationRange: [0, ELEV_MAX],
      elevationScale: HEATMAP.elevationScale,

      material: { ambient: 0.62, diffuse: 0.6, shininess: 24, specularColor: [40, 50, 60] }
    });

    overlay.setProps({ layers: [layer] });

    const ecs = data.map((d) => d.ec);
    const mean = ecs.length ? ecs.reduce((a, b) => a + b, 0) / ecs.length : null;
    statsEl.innerHTML = `
      수심 <b>${activeDepth.toFixed(1)} m</b> · 셀 ${HEATMAP.cellSize} m<br/>
      집계 표본 <b>${data.length}</b>건 · 제외(fault) <b>${excluded}</b>건<br/>
      평균 EC <b>${mean === null ? '-' : mean.toFixed(1)}</b> µS/cm`;
  }

  return {
    map,
    /** 3초 배치로 호출: 표시할 차수의 전체 레코드를 통째로 교체 */
    setRecords(records) { allRecords = records; render(); },
    onDepthChange(cb) { depthChangeCb = cb; },
    getDepth: () => activeDepth,
    fit() {
      map.easeTo({ center: [SITE.lon, SITE.lat], zoom: 14.7, pitch: 55, bearing: -22, duration: 700 });
    },
    resize() { map.resize(); }
  };
}
