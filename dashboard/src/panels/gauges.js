/**
 * panels/gauges.js — 수온 / EC / TDS 게이지 (1초 갱신).
 *
 * CLAUDE.md 6절: stale(2초 이상 미수신) 이면 마지막 값을 회색 처리하고 "연결 끊김"을 명시한다.
 * fault(NaN·범위 밖) 는 값을 지우지 않고 fault 배지로 표시한다.
 */

import { THRESHOLDS, GAUGE_SCALE, classify } from '../config.js';

const FLAG_TEXT = {
  normal: '정상',
  caution: '주의',
  danger: '위험',
  fault: '이상값',
  stale: '연결 끊김'
};

// 게이지 눈금 범위는 config.js 의 GAUGE_SCALE 이 정본이다
// (수온 0~50 ℃ / EC 0~1000 µS/cm / TDS 0~500 ppm — 사용자 확정 2026-08-28).
// 임계값이 아니라 바늘이 도는 범위다. 임계값은 CLAUDE.md 1절 = config.js THRESHOLDS.

// 색 구간 경계 수치 — 화면에 그대로 적어 준다 (사용자 확정 2026-09-02).
// "초록↔노랑" = 정상 상한, "노랑↔빨강" = 위험 임계값. CLAUDE.md 1절 표와 같은 값이다.
const GAUGE_BOUNDS = {
  temp: null,                       // 수온은 주의 구간이 없다 (0~35 밖이면 fault)
  ec: { caution: 280, danger: 700 },
  tds: { caution: 140, danger: 350 }
};

// 눈금 위 색 구간: [시작, 끝, 색]. 하한 미만도 정상이므로 초록이 0 에서 시작한다.
const GAUGE_ZONES = {
  temp: [[0, 35, '#0E8F5F'], [35, 50, '#C62828']],
  ec: [[0, 280, '#0E8F5F'], [280, 700, '#B26A00'], [700, 1000, '#C62828']],
  tds: [[0, 140, '#0E8F5F'], [140, 350, '#B26A00'], [350, 500, '#C62828']]
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

const fmtTick = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));

function gaugeMarkup(metric, name, unit) {
  const [lo, hi] = GAUGE_SCALE[metric];
  const zones = GAUGE_ZONES[metric]
    .map(([a, b, c]) =>
      `<path d="${arcPath(valueToDeg(metric, a), valueToDeg(metric, b))}"
             stroke="${c}" stroke-width="7" fill="none" opacity="0.5" stroke-linecap="butt"/>`)
    .join('');
  // 눈금 양 끝 라벨 — 이 게이지가 어느 범위를 보여주는지 한눈에 (요청 2, 2026-08-28)
  const [lx, ly] = polar(START);
  const [hx, hy] = polar(START + SWEEP);
  // 색이 바뀌는 지점에 짧은 눈금을 세워 아래 숫자와 이어 준다 (2026-09-02)
  const bounds = GAUGE_BOUNDS[metric];
  const boundTicks = !bounds ? '' : [
    [bounds.caution, '#B26A00'], [bounds.danger, '#C62828']
  ].map(([v, c]) => {
    const deg = valueToDeg(metric, v);
    const rad = (deg * Math.PI) / 180;
    const x1 = CX + (R - 5) * Math.cos(rad), y1 = CY + (R - 5) * Math.sin(rad);
    const x2 = CX + (R + 5) * Math.cos(rad), y2 = CY + (R + 5) * Math.sin(rad);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}"
                  y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`;
  }).join('');
  const boundText = bounds
    ? `<span class="b b-caution">주의 ${bounds.caution}</span>`
      + `<span class="b-sep">·</span>`
      + `<span class="b b-danger">위험 ${bounds.danger}</span>`
    : `<span class="b b-ok">정상 0~35</span>`;
  return `
    <div class="gauge" data-metric="${metric}">
      <div class="gauge-name">${name}</div>
      <svg viewBox="0 0 100 84" width="100%" style="max-height:82px">
        <path d="${arcPath(START, START + SWEEP)}" stroke="#E1E4E6" stroke-width="7" fill="none"/>
        ${zones}
        ${boundTicks}
        <text x="${(lx - 1).toFixed(1)}" y="${(ly + 11).toFixed(1)}" class="g-tick"
              text-anchor="middle">${fmtTick(lo)}</text>
        <text x="${(hx + 1).toFixed(1)}" y="${(hy + 11).toFixed(1)}" class="g-tick"
              text-anchor="middle">${fmtTick(hi)}</text>
        <path class="g-needle" d="" stroke="#0F2B3D" stroke-width="3" fill="none" stroke-linecap="round"/>
        <circle cx="${CX}" cy="${CY}" r="3.5" fill="#0F2B3D"/>
      </svg>
      <div class="gauge-value">--<span class="gauge-unit"> ${unit}</span></div>
      <div class="gauge-bounds">${boundText}</div>
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

  /** 좌측 레일에서 고른 표시 항목을 게이지에서도 강조한다 (UI_REQUIREMENTS §4.1). */
  function setSelected(metric) {
    for (const m of ['temp', 'ec', 'tds']) nodes[m].box.classList.toggle('sel', m === metric);
  }

  return { update, setStale, setSelected };
}
