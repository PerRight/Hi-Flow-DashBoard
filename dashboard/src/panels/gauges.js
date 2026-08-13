/**
 * panels/gauges.js — 수온 / EC / TDS 게이지 (1초 갱신).
 *
 * CLAUDE.md 6절: stale(2초 이상 미수신) 이면 마지막 값을 회색 처리하고 "연결 끊김"을 명시한다.
 * fault(NaN·범위 밖) 는 값을 지우지 않고 fault 배지로 표시한다.
 */

import { THRESHOLDS, classify } from '../config.js';

const FLAG_TEXT = {
  normal: '정상',
  caution: '주의',
  danger: '위험',
  fault: '이상값',
  stale: '연결 끊김'
};

// 게이지 눈금 범위(표시용). 임계값 자체가 아니라 바늘이 도는 범위다.
const GAUGE_SCALE = {
  temp: [0, 35],
  ec: [0, 800],
  tds: [0, 400]
};

// 눈금 위 색 구간: [시작, 끝, 색]
const GAUGE_ZONES = {
  temp: [[0, 35, '#34d399']],
  ec: [[0, 100, '#fbbf24'], [100, 280, '#34d399'], [280, 700, '#fbbf24'], [700, 800, '#f87171']],
  tds: [[0, 50, '#fbbf24'], [50, 140, '#34d399'], [140, 350, '#fbbf24'], [350, 400, '#f87171']]
};

const R = 42, CX = 50, CY = 50;
const START = 150, SWEEP = 240; // deg, 아래가 뚫린 게이지

function polar(deg) {
  const rad = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(rad), CY + R * Math.sin(rad)];
}
function arcPath(fromDeg, toDeg) {
  const [x1, y1] = polar(fromDeg);
  const [x2, y2] = polar(toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
function valueToDeg(metric, v) {
  const [lo, hi] = GAUGE_SCALE[metric];
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return START + t * SWEEP;
}

function gaugeMarkup(metric, name, unit) {
  const zones = GAUGE_ZONES[metric]
    .map(([a, b, c]) =>
      `<path d="${arcPath(valueToDeg(metric, a), valueToDeg(metric, b))}"
             stroke="${c}" stroke-width="7" fill="none" opacity="0.35" stroke-linecap="butt"/>`)
    .join('');
  return `
    <div class="gauge" data-metric="${metric}">
      <div class="gauge-name">${name}</div>
      <svg viewBox="0 0 100 78" width="100%" style="max-height:104px">
        <path d="${arcPath(START, START + SWEEP)}" stroke="#26333d" stroke-width="7" fill="none"/>
        ${zones}
        <path class="g-needle" d="" stroke="#dbe6ee" stroke-width="3" fill="none" stroke-linecap="round"/>
        <circle cx="${CX}" cy="${CY}" r="3.5" fill="#dbe6ee"/>
      </svg>
      <div class="gauge-value">--<span class="gauge-unit"> ${unit}</span></div>
      <div class="gauge-flag flag-normal">-</div>
    </div>`;
}

export function createGaugePanel(root) {
  root.innerHTML =
    gaugeMarkup('temp', '수온', THRESHOLDS.temp.unit) +
    gaugeMarkup('ec', 'EC', THRESHOLDS.ec.unit) +
    gaugeMarkup('tds', 'TDS', THRESHOLDS.tds.unit);

  const nodes = {};
  for (const metric of ['temp', 'ec', 'tds']) {
    const box = root.querySelector(`.gauge[data-metric="${metric}"]`);
    nodes[metric] = {
      box,
      needle: box.querySelector('.g-needle'),
      value: box.querySelector('.gauge-value'),
      unit: box.querySelector('.gauge-unit'),
      flag: box.querySelector('.gauge-flag')
    };
  }

  const decimals = { temp: 1, ec: 1, tds: 1 };
  let last = { temp: null, ec: null, tds: null };
  let stale = false;

  function paint(metric) {
    const n = nodes[metric];
    const v = last[metric];
    const level = classify(metric, v);

    if (v === null || v === undefined || Number.isNaN(v)) {
      n.value.firstChild.nodeValue = '--';
      n.needle.setAttribute('d', '');
    } else {
      n.value.firstChild.nodeValue = v.toFixed(decimals[metric]);
      const deg = valueToDeg(metric, v);
      const [x, y] = polar(deg);
      const ix = CX + (R - 15) * Math.cos((deg * Math.PI) / 180);
      const iy = CY + (R - 15) * Math.sin((deg * Math.PI) / 180);
      n.needle.setAttribute('d', `M ${ix.toFixed(2)} ${iy.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }

    n.box.classList.remove('lv-caution', 'lv-danger', 'lv-fault');
    if (!stale && level !== 'normal') n.box.classList.add(`lv-${level}`);
    n.box.classList.toggle('is-stale', stale);

    const shownLevel = stale ? 'stale' : level;
    n.flag.textContent = FLAG_TEXT[shownLevel];
    n.flag.className = `gauge-flag flag-${shownLevel}`;
  }

  /** 1 Hz 로 호출. msg 는 live 메시지(CLAUDE.md 1절) — 이동 중에도 계속 들어온다. */
  function update(msg) {
    last = { temp: msg.temp, ec: msg.ec, tds: msg.tds };
    for (const m of ['temp', 'ec', 'tds']) paint(m);
  }

  function setStale(isStale) {
    if (stale === isStale) return;
    stale = isStale;
    for (const m of ['temp', 'ec', 'tds']) paint(m);
  }

  return { update, setStale };
}
