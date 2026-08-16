/**
 * panels/heatmap.js — EC/TDS 3D 히트맵 (deck.gl GridLayer), 깊이 0.5/1.0/1.5 m 3개 탭 슬라이스.
 *
 * TDS 히트맵 추가(사용자 확정, 2026-08-16) — "3D 히트맵 예시" 처럼 격자마다 개별 막대가
 * 뚜렷하게 솟아오르는 형태를 유지하면서, EC/TDS 를 탭으로 전환해서 본다.
 * 참고: 캡스톤 폴더의 dashboard.html 히트맵 패널(막대뷰의 오염 셀 요약 문구)에서
 * "위험 레코드 요약 한 줄" 아이디어만 가져왔다 — 그 외 패널(센서 카드·GPS 등)은 이식하지 않는다.
 *
 * CLAUDE.md 1절 준수 사항
 *  - 컬러 도메인은 metric별로 고정(EC [100,280] / TDS [50,140]). 초과분은 전용 경고색(짙은 자주).
 *  - 막대 높이(elevation)는 실측값에 정비례. 값을 왜곡하는 확대 금지.
 *  - fault 레코드는 집계에서 제외(6절). 단, 원자료에서 지우지는 않는다.
 *
 * 색 구현 방식: 이전 EC 전용 구현과 동일 — GridLayer 의 quantize 컬러 스케일이
 * (domainMax-domainMin)/colorRange.length 폭으로 균등 분할하는 성질을 이용해
 * 정상 6단계 팔레트 뒤에 경고색 버킷을 이어붙인다(metric별 dangerMin 기준).
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GridLayer } from '@deck.gl/aggregation-layers';
import { SITE, HEATMAP, DEPTH_LEVELS, isAggregatable } from '../config.js';
import { makeBasemapStyle } from '../basemap.js';

const ELEV_MAX_DEFAULT = 800;

/** metric 설정 하나로 GridLayer 의 colorDomain/colorRange/elevMax 를 계산(1회, 캐시) */
function buildMetricScale(cfg) {
  const bucket = (cfg.colorDomain[1] - cfg.colorDomain[0]) / cfg.colorRange.length;
  const range = [...cfg.colorRange];
  const cautionBuckets = Math.round((cfg.dangerMin - cfg.colorDomain[1]) / bucket);
  for (let i = 0; i < cautionBuckets; i++) range.push(cfg.overColor);
  range.push(cfg.dangerColor);
  const domain = [cfg.colorDomain[0], cfg.colorDomain[0] + bucket * range.length];
  return { colorRange: range, colorDomain: domain, elevMax: cfg.elevMax ?? ELEV_MAX_DEFAULT };
}

const METRIC_SCALES = Object.fromEntries(
  Object.entries(HEATMAP.metrics).map(([key, cfg]) => [key, buildMetricScale(cfg)])
);

export function createHeatmapPanel(containerId, tabsId, legendId, statsId, metricTabsId) {
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

  let activeDepth = DEPTH_LEVELS[0];
  let activeMetric = 'ec';

  const overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
    getTooltip: ({ object }) => {
      if (!object) return null;
      const cfg = HEATMAP.metrics[activeMetric];
      // deck.gl 버전/집계 방식(GPU·CPU)에 따라 picking 결과 형태가 달라 방어적으로 읽는다.
      const pts = object.points;
      const vals = Array.isArray(pts)
        ? pts.map((p) => (p && p.source ? p.source[activeMetric] : p && p[activeMetric])).filter(Number.isFinite)
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
                 <b>평균 ${cfg.label} ${mean.toFixed(1)} ${cfg.unit}</b><br/>표본 ${count}건${extra}
               </div>`,
        style: { background: '#151d23', color: '#dbe6ee', border: '1px solid #26333d',
                 borderRadius: '6px', padding: '6px 8px' }
      };
    }
  });
  map.addControl(overlay);

  // ── 표시 항목 탭 (EC / TDS) ────────────────────────────────────────────
  const metricTabs = document.getElementById(metricTabsId);
  const metricKeys = Object.keys(HEATMAP.metrics);
  metricTabs.innerHTML = metricKeys
    .map((k, i) => `<button data-metric="${k}" class="${i === 0 ? 'active' : ''}">${HEATMAP.metrics[k].label}</button>`)
    .join('');
  metricTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-metric]');
    if (!btn) return;
    activeMetric = btn.dataset.metric;
    [...metricTabs.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    renderLegend();
    render();
  });

  // ── 깊이 탭 ────────────────────────────────────────────────────────────
  const tabs = document.getElementById(tabsId);
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

  // ── 범례 (metric 전환 시 다시 그린다) ───────────────────────────────────
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const legendEl = document.getElementById(legendId);
  function renderLegend() {
    const cfg = HEATMAP.metrics[activeMetric];
    const [lo, mid, hi] = [cfg.colorDomain[0], (cfg.colorDomain[0] + cfg.colorDomain[1]) / 2, cfg.colorDomain[1]];
    legendEl.innerHTML = `
      <div class="legend-title">${cfg.label} (${cfg.unit}) · 컬러 도메인 ${lo}~${hi} 고정</div>
      <div class="legend-bar">${cfg.colorRange.map((c) => `<i style="background:${rgb(c)}"></i>`).join('')}</div>
      <div class="legend-scale"><span>${lo}</span><span>${mid}</span><span>${hi}</span></div>
      <div class="legend-extra">
        <span class="legend-swatch" style="background:${rgb(cfg.overColor)}"></span>
        <span>${hi} 초과 (주의)</span>
      </div>
      <div class="legend-extra">
        <span class="legend-swatch" style="background:${rgb(cfg.dangerColor)}"></span>
        <span>${cfg.dangerMin} 초과 (위험)</span>
      </div>
      <div class="legend-extra"><span style="color:#8598a6">막대 높이 = 평균 ${cfg.label} 비례</span></div>`;
  }
  renderLegend();

  const statsEl = document.getElementById(statsId);
  let allRecords = [];

  function render() {
    const cfg = HEATMAP.metrics[activeMetric];
    const scale = METRIC_SCALES[activeMetric];

    // fault 제외 + 선택한 수심만 (CLAUDE.md 6절 · 3절)
    // 측정 레코드의 depth 는 항상 0.5/1.0/1.5 중 하나이므로(1절) 정확 일치로 거른다.
    const total = allRecords.filter((r) => r.depth === activeDepth);
    const data = total.filter((r) => isAggregatable(r, activeMetric));
    const excluded = total.length - data.length;

    const layer = new GridLayer({
      id: `grid-${activeMetric}-${activeDepth}`,
      data,
      pickable: true,
      extruded: true,
      cellSize: HEATMAP.cellSize,
      coverage: 0.92,
      getPosition: (d) => [d.lon, d.lat],

      // 색: 평균값
      colorAggregation: 'MEAN',
      getColorWeight: (d) => d[activeMetric],
      colorScaleType: 'quantize',
      colorDomain: scale.colorDomain,
      colorRange: scale.colorRange,

      // 높이: 평균값에 정비례 (도메인=레인지 → 항등 선형, 왜곡 없음)
      elevationAggregation: 'MEAN',
      getElevationWeight: (d) => d[activeMetric],
      elevationScaleType: 'linear',
      elevationDomain: [0, scale.elevMax],
      elevationRange: [0, scale.elevMax],
      elevationScale: cfg.elevationScale,

      material: { ambient: 0.62, diffuse: 0.6, shininess: 24, specularColor: [40, 50, 60] }
    });

    overlay.setProps({ layers: [layer] });

    const vals = data.map((d) => d[activeMetric]);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

    // 위험 레코드 요약 한 줄 — 캡스톤 dashboard.html 히트맵 패널의 오염 요약에서 착안.
    // (셀 평균이 아니라 개별 측정값 기준 — GridLayer 내부 집계를 다시 구현하지 않고 간단히 낸다.)
    const overDanger = data.filter((d) => d[activeMetric] > cfg.dangerMin);
    let dangerLine = `<span style="color:#8598a6">위험 임계값(${cfg.dangerMin}${cfg.unit}) 초과 없음</span>`;
    if (overDanger.length) {
      const worst = overDanger.reduce((a, b) => (b[activeMetric] > a[activeMetric] ? b : a));
      dangerLine = `<span style="color:#f87171">⚠ 위험 레코드 ${overDanger.length}건 · 최고 `
        + `${worst[activeMetric].toFixed(1)} ${cfg.unit} (수심 ${worst.depth.toFixed(1)} m)</span>`;
    }

    statsEl.innerHTML = `
      수심 <b>${activeDepth.toFixed(1)} m</b> · 셀 ${HEATMAP.cellSize} m<br/>
      집계 표본 <b>${data.length}</b>건 · 제외(fault) <b>${excluded}</b>건<br/>
      평균 ${cfg.label} <b>${mean === null ? '-' : mean.toFixed(1)}</b> ${cfg.unit}<br/>
      ${dangerLine}`;
  }

  return {
    map,
    /** 3초 배치로 호출: 표시할 차수의 전체 레코드를 통째로 교체 */
    setRecords(records) { allRecords = records; render(); },
    onDepthChange(cb) { depthChangeCb = cb; },
    getDepth: () => activeDepth,
    getMetric: () => activeMetric,
    fit() {
      map.easeTo({ center: [SITE.lon, SITE.lat], zoom: 14.7, pitch: 55, bearing: -22, duration: 700 });
    },
    resize() { map.resize(); }
  };
}
