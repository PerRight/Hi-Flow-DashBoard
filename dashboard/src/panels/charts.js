/**
 * panels/charts.js — EC / TDS / 수온 시계열 (최근 5분, 1초 갱신).
 *
 * 입력은 live 메시지(1 Hz 상시)다. 이동 중에도 끊기지 않는다.
 * CLAUDE.md 6절: 미수신 구간(stale)은 값을 이어 붙이지 않고 공백으로 남긴다(null).
 * fault 값도 차트에서는 공백 처리하고, 게이지에서 '이상값' 배지로 알린다.
 */

import {
  Chart, LineController, LineElement, PointElement,
  LinearScale, CategoryScale, Filler, Tooltip
} from 'chart.js';
import { SERIES_WINDOW_S, THRESHOLDS } from '../config.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

Chart.defaults.font.family = '"Malgun Gothic", system-ui, sans-serif';
Chart.defaults.color = '#8598a6';
Chart.defaults.animation = false;

const N = SERIES_WINDOW_S;

const SPEC = {
  ec: {
    canvas: 'chart-ec',
    title: `EC (${THRESHOLDS.ec.unit})`,
    color: '#38bdf8',
    // 정상대역 [100,280] 을 항상 보이게 하되, 주의/위험값이 들어오면 자동 확장
    baseMin: 80, baseMax: 320,
    bands: [{ from: 100, to: 280, color: 'rgba(52, 211, 153, 0.10)' }]
  },
  tds: {
    canvas: 'chart-tds',
    title: `TDS (${THRESHOLDS.tds.unit})`,
    color: '#a78bfa',
    // 정상대역 [50,140] 을 항상 보이게 하되, 주의/위험값이 들어오면 자동 확장
    baseMin: 40, baseMax: 160,
    bands: [{ from: 50, to: 140, color: 'rgba(52, 211, 153, 0.10)' }]
  },
  temp: {
    canvas: 'chart-temp',
    title: `수온 (${THRESHOLDS.temp.unit})`,
    color: '#fbbf24',
    baseMin: 0, baseMax: 35,
    bands: []
  }
};

/** 정상 대역을 옅게 칠하는 최소 플러그인 */
const bandPlugin = {
  id: 'normalBand',
  beforeDatasetsDraw(chart, _args, opts) {
    const bands = opts?.bands;
    if (!bands || !bands.length) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    for (const b of bands) {
      const y1 = scales.y.getPixelForValue(b.to);
      const y2 = scales.y.getPixelForValue(b.from);
      ctx.save();
      ctx.fillStyle = b.color;
      ctx.fillRect(chartArea.left, y1, chartArea.right - chartArea.left, y2 - y1);
      ctx.restore();
    }
  }
};
Chart.register(bandPlugin);

function makeChart(spec) {
  const canvas = document.getElementById(spec.canvas);
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: new Array(N).fill(''),
      datasets: [{
        data: new Array(N).fill(null),
        borderColor: spec.color,
        borderWidth: 1.6,
        pointRadius: 0,
        spanGaps: false,      // 공백 구간은 선을 잇지 않는다 (CLAUDE.md 6절)
        tension: 0.15,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        normalBand: { bands: spec.bands },
        title: {
          display: true,
          text: spec.title,
          color: '#8598a6',
          font: { size: 11, weight: '700' },
          padding: { top: 0, bottom: 4 }
        }
      },
      scales: {
        x: { display: false, grid: { display: false } },
        y: {
          suggestedMin: spec.baseMin,
          suggestedMax: spec.baseMax,
          grid: { color: '#1f2b33' },
          ticks: { font: { size: 10 }, maxTicksLimit: 5 }
        }
      }
    }
  });
}

export function createChartPanel() {
  const charts = {};
  const series = {};
  for (const key of Object.keys(SPEC)) {
    charts[key] = makeChart(SPEC[key]);
    series[key] = new Array(N).fill(null);
  }
  const labels = new Array(N).fill('');

  const inScale = (key, v) => {
    if (!Number.isFinite(v)) return false;
    // 차트 스케일을 파괴하지 않는 선에서만 그린다 (fault 범위 밖 값은 공백 처리)
    if (key === 'ec') return v >= 0 && v <= 3000;
    if (key === 'tds') return v >= 0 && v <= 1500;
    if (key === 'temp') return v >= -5 && v <= 45;
    return true;
  };

  /**
   * 1초에 정확히 한 번 호출한다.
   * @param {object|null} msg 이번 초에 수신한 live 메시지. 미수신이면 null → 공백.
   *   live 스키마에는 ts 가 없으므로(CLAUDE.md 1절) 라벨은 수신 시각(브라우저 시계)으로 찍는다.
   */
  function push(msg) {
    const label = msg
      ? new Date().toLocaleTimeString('ko-KR', { hour12: false })
      : '';
    labels.push(label); labels.shift();

    for (const key of Object.keys(SPEC)) {
      let v = null;
      if (msg && msg.status !== 'fault' && inScale(key, msg[key])) v = msg[key];
      series[key].push(v); series[key].shift();
    }
  }

  /** 실제 캔버스 갱신 (1초 주기). */
  function render() {
    for (const key of Object.keys(SPEC)) {
      const c = charts[key];
      c.data.labels = labels;
      c.data.datasets[0].data = series[key];
      c.update('none');
    }
  }

  function reset() {
    for (const key of Object.keys(SPEC)) series[key].fill(null);
    labels.fill('');
    render();
  }

  function resize() { for (const key of Object.keys(SPEC)) charts[key].resize(); }

  return { push, render, reset, resize };
}
