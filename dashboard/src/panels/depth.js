/**
 * panels/depth.js — 현재 수심 게이지 + 하강/상승 진행 표시 + 윈치 조작 버튼.
 *
 * 데이터 원본은 live 메시지(CLAUDE.md 1절)의 `state` 와 `depth_est` 다.
 * 이동 중(DESCENDING/ASCENDING)에도 1 Hz 로 들어오므로 하강 진행 표시가 끊기지 않는다.
 * 자동 여부·측정 경과 초 등 조작 보조 정보는 setWinchMeta() 로 별도 주입한다.
 *
 * 대시보드는 명령만 보낸다(CLAUDE.md 0절). 상태기계는 라즈베리파이(1단계에서는 mock-stream)가 소유.
 * DOM은 최초 1회만 만들고 이후에는 textContent/style 만 갱신한다(전체 리렌더 금지).
 */

import { DEPTH_LEVELS, HOLD_SECONDS } from '../config.js';

const MAX_DEPTH = DEPTH_LEVELS[DEPTH_LEVELS.length - 1];
const BAR_H = 210;
const BAR_TOP = 14;

const STATE_LABEL = {
  SURFACE: '수면 대기',
  DESCENDING: '하강 중',
  HOLD: '측정 중 (정지)',
  ASCENDING: '상승 중'
};

/** depth_est 가 측정 수심(0.5/1.0/1.5)에 도달했는지 — 아니면 null */
const atLevel = (d) => DEPTH_LEVELS.find((l) => Math.abs(d - l) < 0.05) ?? null;

export function createDepthPanel(root, onCommand) {
  root.innerHTML = `
    <div class="depth-wrap">
      <div class="depth-col">
        <svg viewBox="0 0 96 ${BAR_H + 28}" width="100%" height="100%"
             preserveAspectRatio="xMidYMid meet" aria-label="수심 게이지">
          <defs>
            <linearGradient id="waterGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#164e63"/>
              <stop offset="100%" stop-color="#082f3d"/>
            </linearGradient>
          </defs>
          <rect x="26" y="${BAR_TOP}" width="30" height="${BAR_H}" rx="4"
                fill="url(#waterGrad)" stroke="#26333d"/>
          <g id="depth-ticks"></g>
          <line id="probe-line" x1="41" y1="${BAR_TOP}" x2="41" y2="${BAR_TOP}"
                stroke="#38bdf8" stroke-width="2"/>
          <g id="probe">
            <rect x="33" y="-7" width="16" height="14" rx="3" fill="#38bdf8"/>
          </g>
          <text x="41" y="${BAR_TOP - 4}" fill="#8598a6" font-size="9"
                text-anchor="middle">수면</text>
        </svg>
      </div>

      <div class="depth-info">
        <div>
          <div class="depth-readout">
            <span class="depth-value" id="depth-value">0.00</span>
            <span class="depth-unit">m</span>
          </div>
          <div class="hint" id="depth-target">목표 수심 —</div>
        </div>

        <span class="state-badge state-SURFACE" id="winch-state">수면 대기</span>

        <div>
          <div class="progress-label" id="progress-label">측정 진행</div>
          <div class="progress"><i id="progress-fill" style="width:0%"></i></div>
        </div>

        <div class="winch-btns">
          <button data-cmd="down">▼ 내림</button>
          <button data-cmd="stop">■ 정지</button>
          <button data-cmd="up">▲ 올림</button>
        </div>
        <div class="auto-row">
          <button class="mini-btn" data-cmd="auto" id="btn-auto">자동 순환</button>
          <span id="auto-flag">자동</span>
        </div>
      </div>
    </div>`;

  // 수심 눈금 (0.5 / 1.0 / 1.5 m)
  const ticks = root.querySelector('#depth-ticks');
  let tickSvg = '';
  for (const d of DEPTH_LEVELS) {
    const y = BAR_TOP + (d / MAX_DEPTH) * BAR_H;
    tickSvg += `<line x1="22" y1="${y}" x2="60" y2="${y}" stroke="#3b4c59" stroke-dasharray="3 3"/>` +
               `<text x="62" y="${y + 3}" fill="#8598a6" font-size="9">${d.toFixed(1)}</text>`;
  }
  ticks.innerHTML = tickSvg;

  const el = {
    value: root.querySelector('#depth-value'),
    target: root.querySelector('#depth-target'),
    state: root.querySelector('#winch-state'),
    progLabel: root.querySelector('#progress-label'),
    progFill: root.querySelector('#progress-fill'),
    probe: root.querySelector('#probe'),
    line: root.querySelector('#probe-line'),
    autoFlag: root.querySelector('#auto-flag'),
    buttons: [...root.querySelectorAll('[data-cmd]')]
  };

  el.buttons.forEach((b) => {
    b.addEventListener('click', () => onCommand(b.dataset.cmd));
  });

  let live = null;   // 최신 live 메시지 (state, depth_est)
  let meta = { auto: true, holdElapsed: 0, holdTotal: HOLD_SECONDS, nextLevel: null };

  function paint() {
    if (!live) return;
    const state = live.state;
    const depth = Number.isFinite(live.depth_est) ? live.depth_est : 0;

    const y = BAR_TOP + Math.min(depth / MAX_DEPTH, 1) * BAR_H;
    el.probe.setAttribute('transform', `translate(0 ${y})`);
    el.line.setAttribute('y2', String(y));
    el.value.textContent = depth.toFixed(2);

    el.state.textContent = STATE_LABEL[state] ?? state;
    el.state.className = `state-badge state-${state}`;

    // 진행 표시: HOLD면 측정 경과, 이동 중이면 목표 수심까지의 진행률
    if (state === 'HOLD') {
      const lv = atLevel(depth);
      el.progLabel.textContent = `측정 진행 ${meta.holdElapsed}/${meta.holdTotal}초`;
      el.progFill.style.width = `${Math.min(100, (meta.holdElapsed / HOLD_SECONDS) * 100)}%`;
      // 측정 수심이 아니면 측정 레코드가 생기지 않는다(1절: depth 는 0.5/1.0/1.5 만).
      el.target.textContent = lv === null
        ? '측정 수심 아님 — 기록되지 않음'
        : `측정 수심 ${lv.toFixed(1)} m 유지`;
    } else if (state === 'DESCENDING') {
      const tgt = meta.nextLevel ?? MAX_DEPTH;
      el.progLabel.textContent = '하강 진행';
      el.progFill.style.width = `${Math.min(100, (depth / tgt) * 100)}%`;
      el.target.textContent = `목표 수심 ${tgt.toFixed(1)} m`;
    } else if (state === 'ASCENDING') {
      el.progLabel.textContent = '상승 진행';
      el.progFill.style.width = `${Math.max(0, 100 - (depth / MAX_DEPTH) * 100)}%`;
      el.target.textContent = '수면 복귀 중';
    } else {
      el.progLabel.textContent = '대기';
      el.progFill.style.width = '0%';
      el.target.textContent = meta.auto ? '자동 순환 대기' : '목표 수심 —';
    }

    el.autoFlag.textContent = meta.auto ? '자동 순환 ON' : '수동 조작';
    root.querySelector('#btn-auto').classList.toggle('active', meta.auto);
    el.buttons.forEach((b) => {
      if (b.dataset.cmd === 'auto') return;
      const active =
        (b.dataset.cmd === 'down' && state === 'DESCENDING') ||
        (b.dataset.cmd === 'stop' && (state === 'HOLD' || state === 'SURFACE')) ||
        (b.dataset.cmd === 'up' && state === 'ASCENDING');
      b.classList.toggle('active', active && !meta.auto);
    });
  }

  /** live 메시지 1건 (1 Hz). 수심·상태의 유일한 출처. */
  function update(msg) {
    live = msg;
    paint();
  }

  /** 윈치 조작 보조 정보(자동 여부·측정 경과·다음 목표). 스키마 외 UI 전용. */
  function setWinchMeta(s) {
    meta = s;
    paint();
  }

  /** 연결 끊김 시: 표시 중인 수심이 실제와 다를 수 있으므로 회색 처리 */
  function setStale(isStale) {
    root.style.opacity = isStale ? '0.5' : '1';
    root.style.filter = isStale ? 'grayscale(1)' : 'none';
    if (isStale) el.target.textContent = '연결 끊김 — 수심 미확인';
    else paint();
  }

  return { update, setWinchMeta, setStale };
}
