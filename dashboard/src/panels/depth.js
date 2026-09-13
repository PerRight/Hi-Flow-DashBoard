/**
 * panels/depth.js — 현재 수심 게이지 + 측정 진행 표시 + 윈치 조작 버튼.
 *
 * 데이터 원본은 live 메시지(CLAUDE.md 1절)의 `state` · `depth_est` 와,
 * 2026-08-28 에 추가한 `measuring` · `hold_elapsed` · `hold_total` 이다.
 * 측정 경과를 대시보드가 세지 않고 서버 값을 그대로 그린다.
 *
 * 조작 흐름 (사용자 확정 2026-08-28 — 자동 순환 삭제):
 *   측정 시작 → 0 → 0.5 m 하강 후 **자동 정지** → 30초 측정
 *   → 30/30 초에서 "측정 완료" 표기 후 대기 → ▼ 내림 → 1.0 m … → 1.5 m
 *   → 측정 완료 → 0 m 부상. 한 지점 1사이클이며 측정 차수는 유지된다.
 *
 * 대시보드는 명령만 보낸다(CLAUDE.md 0절). 상태기계는 라즈베리파이가 소유.
 * DOM은 최초 1회만 만들고 이후에는 textContent/style 만 갱신한다(전체 리렌더 금지).
 */

import { DEPTH_LEVELS, HOLD_SECONDS } from '../config.js';

const MAX_DEPTH = DEPTH_LEVELS[DEPTH_LEVELS.length - 1];
const BAR_H = 210;
const BAR_TOP = 28;   // 프로브가 '수면' 라벨을 덮지 않게 (UI_REQUIREMENTS §3.8)
const EPS = 0.05;

/** depth_est 가 측정 수심(0.5/1.0/1.5)에 도달했는지 — 아니면 null */
const atLevel = (d) => DEPTH_LEVELS.find((l) => Math.abs(d - l) < EPS) ?? null;

export function createDepthPanel(root, onCommand) {
  root.innerHTML = `
    <div class="depth-wrap">
      <div class="depth-col">
        <svg viewBox="0 0 78 ${BAR_H + 44}" width="100%" height="100%"
             preserveAspectRatio="xMidYMid meet" aria-label="수심 게이지">
          <defs>
            <!-- 수면 회색 → 심부 하늘색 (사용자 확정 2026-08-29).
                 예전에는 파랑→남색이었는데 아래로 갈수록 어두워 프로브가 묻혔다. -->
            <linearGradient id="waterGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stop-color="#DCE3E8"/>
              <stop offset="18%"  stop-color="#BBD6EA"/>
              <stop offset="55%"  stop-color="#6FBCEC"/>
              <stop offset="100%" stop-color="#1E93DC"/>
            </linearGradient>
          </defs>
          <rect x="26" y="${BAR_TOP}" width="30" height="${BAR_H}" rx="4"
                fill="url(#waterGrad)" stroke="#9FBACB"/>
          <g id="depth-ticks"></g>
          <line id="probe-line" x1="41" y1="${BAR_TOP}" x2="41" y2="${BAR_TOP}"
                stroke="#FFF671" stroke-width="2.6"/>
          <!-- 프로브(수중 센서) — 케이블에 물린 **가로형 모듈**.
               세로 알약 모양은 "낚시 찌 같다"는 의견으로 두 번 교체했다 (2026-08-29). -->
          <g id="probe">
            <line x1="14" y1="0" x2="68" y2="0" stroke="#7C8B95" stroke-width="1"
                  stroke-dasharray="2 3" opacity="0.7"/>
            <rect x="22" y="-2.6" width="38" height="5.2" rx="1.4" fill="#FFF671" opacity="0.7"/>
            <rect x="27" y="-5.5" width="28" height="11" rx="2.5"
                  fill="#FFF671" stroke="#1B1B1B" stroke-width="1.3"/>
            <rect x="31" y="-2" width="20" height="4" rx="1" fill="#1B1B1B" opacity="0.55"/>
            <path d="M24 -3.4 V3.4 M58 -3.4 V3.4" stroke="#1B1B1B" stroke-width="1.6"
                  stroke-linecap="round"/>
          </g>
          <text x="41" y="${BAR_TOP - 14}" fill="#3D5A6C" font-size="9" font-weight="700"
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

        <!-- 상태 배지와 진행 표시를 하나로 통합 (사용자 확정 2026-08-28) -->
        <div class="measure-box">
          <div class="measure-head">
            <span class="state-badge state-SURFACE" id="winch-state">수면 대기</span>
            <span class="measure-count num" id="measure-count">—</span>
          </div>
          <div class="progress"><i id="progress-fill" style="width:0%"></i></div>
          <div class="measure-sub" id="measure-sub">측정 시작을 누르면 0.5 m 로 내려갑니다.</div>
        </div>

        <div class="winch-btns" id="winch-btns">
          <button data-cmd="down">▼ 내림</button>
          <button data-cmd="stop">■ 정지</button>
          <button data-cmd="up">▲ 올림</button>
        </div>
        <div class="measure-btns" id="measure-btns">
          <button class="btn" data-cmd="measure_start" id="btn-start">측정 시작</button>
          <button class="btn sec" data-cmd="measure_end" id="btn-end">측정 완료</button>
        </div>
        <p class="hint sync-note" id="sync-note" title="내림·정지·올림·측정 시작·측정 완료 — 대시보드 버튼은 실제 윈치 조작과 동시에 눌러야 수심 추정이 맞습니다">버튼을 동시에 눌러주세요.</p>
        <p class="note remote-note" id="remote-note" hidden>원격 화면입니다 — 윈치 조작은 보트 위 대시보드에서만 할 수 있습니다.</p>
      </div>
    </div>`;

  // 수심 눈금 (0.5 / 1.0 / 1.5 m)
  const ticks = root.querySelector('#depth-ticks');
  let tickSvg = '';
  for (const d of DEPTH_LEVELS) {
    const y = BAR_TOP + (d / MAX_DEPTH) * BAR_H;
    tickSvg += `<line x1="24" y1="${y}" x2="59" y2="${y}" stroke="#FFFFFF" stroke-opacity="0.75" stroke-dasharray="3 3"/>` +
               `<text x="63" y="${y + 3}" fill="#5D7A8C" font-size="9.5" font-weight="600">${d.toFixed(1)}</text>`;
  }
  ticks.innerHTML = tickSvg;

  const el = {
    value: root.querySelector('#depth-value'),
    target: root.querySelector('#depth-target'),
    state: root.querySelector('#winch-state'),
    count: root.querySelector('#measure-count'),
    sub: root.querySelector('#measure-sub'),
    progFill: root.querySelector('#progress-fill'),
    probe: root.querySelector('#probe'),
    line: root.querySelector('#probe-line'),
    btnStart: root.querySelector('#btn-start'),
    btnEnd: root.querySelector('#btn-end'),
    buttons: [...root.querySelectorAll('[data-cmd]')],
    winchBtns: root.querySelector('#winch-btns'),
    measureBtns: root.querySelector('#measure-btns'),
    syncNote: root.querySelector('#sync-note'),
    remoteNote: root.querySelector('#remote-note')
  };
  const btnDown = el.buttons.find((b) => b.dataset.cmd === 'down');

  // 원격(클라우드 미러) 화면에서는 조작을 아예 감춘다 (CLAUDE.md 0절).
  let readOnly = false;
  function setReadOnly(on) {
    readOnly = !!on;
    el.winchBtns.hidden = readOnly;
    el.measureBtns.hidden = readOnly;
    el.syncNote.hidden = readOnly;
    el.remoteNote.hidden = !readOnly;
  }

  el.buttons.forEach((b) => {
    b.addEventListener('click', () => {
      if (readOnly || b.disabled) return;
      onCommand(b.dataset.cmd);
    });
  });

  let live = null;   // 최신 live 메시지 (state, depth_est)
  let meta = {
    measuring: false, holdElapsed: 0, holdTotal: HOLD_SECONDS, holdDone: false,
    nextLevel: null, surveyOpen: false
  };

  function paint() {
    if (!live) return;
    const state = live.state;
    const depth = Number.isFinite(live.depth_est) ? live.depth_est : 0;
    const lv = atLevel(depth);
    const total = meta.holdTotal || HOLD_SECONDS;
    const elapsed = Math.min(total, Math.round(meta.holdElapsed));
    const done = state === 'HOLD' && elapsed >= total;
    const nextLv = DEPTH_LEVELS.find((l) => l > depth + EPS) ?? null;

    const y = BAR_TOP + Math.min(depth / MAX_DEPTH, 1) * BAR_H;
    el.probe.setAttribute('transform', `translate(0 ${y})`);
    el.line.setAttribute('y2', String(y));
    el.value.textContent = depth.toFixed(2);

    // ── 통합 상태 표시: 배지 + n/30초 + 진행 바 ─────────────────────────
    // subWarn: 조작자가 지금 뭔가 해야 한다는 뜻 — 빨간 글씨로 눈에 띄게 한다.
    let badge, badgeCls = state, count, pct = 0, sub, subWarn = false;

    if (state === 'HOLD') {
      badge = done ? '측정 완료' : '측정 중';
      badgeCls = done ? 'DONE' : 'HOLD';
      count = `측정 진행 상황 ${elapsed}/${total}초`;
      pct = (elapsed / total) * 100;
      if (lv === null) {
        sub = '측정 수심(0.5 / 1.0 / 1.5 m)이 아니어서 기록되지 않습니다.';
      } else if (done) {
        // 다음 동작 안내는 줄을 바꿔서 눈에 띄게 한다 (사용자 확정 2026-09-06)
        sub = nextLv !== null
          ? `${lv.toFixed(1)} m 측정 완료<br>▼ 내림을 눌러 ${nextLv.toFixed(1)} m 로 진행하세요.`
          : `${lv.toFixed(1)} m 측정 완료<br>측정 완료를 눌러 수면으로 올리세요.`;
      } else {
        sub = `${lv.toFixed(1)} m 에서 측정 중입니다.`;
      }
      el.target.textContent = lv === null
        ? '측정 수심 아님 — 기록되지 않음'
        : `측정 수심 ${lv.toFixed(1)} m 유지`;
    } else if (state === 'DESCENDING') {
      const tgt = meta.nextLevel ?? nextLv ?? MAX_DEPTH;
      badge = '하강 중';
      count = `${depth.toFixed(2)} / ${tgt.toFixed(1)} m`;
      pct = Math.min(100, (depth / tgt) * 100);
      sub = `${tgt.toFixed(1)} m 에 닿으면 자동으로 멈추고 측정을 시작합니다.`;
      el.target.textContent = `목표 수심 ${tgt.toFixed(1)} m`;
    } else if (state === 'ASCENDING') {
      badge = '상승 중';
      count = `${depth.toFixed(2)} / 0.00 m`;
      pct = Math.max(0, 100 - (depth / MAX_DEPTH) * 100);
      sub = '수면으로 올리는 중입니다.';
      el.target.textContent = '수면 복귀 중';
    } else {
      badge = '수면 대기';
      count = '—';
      // 차수가 열려 있지 않으면 측정해도 기록될 곳이 없다 (사용자 확정 2026-08-29).
      if (meta.surveyOpen) {
        sub = '측정 시작을 누르면 0.5 m 로 내려갑니다.';
      } else {
        sub = '우측의 수질 측정 시작란에 지역을 입력해주세요.';
        subWarn = true;
      }
      el.target.textContent = '목표 수심 —';
    }

    el.state.textContent = badge;
    el.state.className = `state-badge state-${badgeCls}`;
    el.count.textContent = count;
    el.progFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    el.progFill.classList.toggle('done', done);
    el.sub.innerHTML = sub;
    el.sub.classList.toggle('warn', subWarn);

    // ── 버튼 가능 여부 ────────────────────────────────────────────────
    const measuring = meta.measuring || state !== 'SURFACE';
    // 차수가 없으면 측정 시작 자체를 막는다 — 눌러도 서버가 거절한다.
    el.btnStart.disabled = measuring || depth > EPS || !meta.surveyOpen;
    el.btnStart.title = meta.surveyOpen ? '' : '차수를 먼저 시작하세요';
    el.btnEnd.disabled = !measuring;
    btnDown.disabled = !measuring || nextLv === null || state === 'DESCENDING';

    el.buttons.forEach((b) => {
      const active =
        (b.dataset.cmd === 'down' && state === 'DESCENDING') ||
        (b.dataset.cmd === 'stop' && state === 'HOLD') ||
        (b.dataset.cmd === 'up' && state === 'ASCENDING');
      b.classList.toggle('active', active);
    });
    // 다음에 눌러야 할 버튼을 강조한다 (완료 후 대기 중임을 알리는 신호).
    btnDown.classList.toggle('next', done && nextLv !== null);
    el.btnEnd.classList.toggle('next', done && nextLv === null);
    el.btnStart.classList.toggle('next', !measuring && depth <= EPS && !!meta.surveyOpen);
  }

  /** live 메시지 1건 (1 Hz). 수심·상태의 유일한 출처. */
  function update(msg) {
    live = msg;
    paint();
  }

  /** 측정 진행 보조 정보(측정 중 여부·경과·다음 목표). ws-client 가 live 에서 뽑아 준다. */
  function setWinchMeta(s) {
    meta = s;
    paint();
  }

  /** 연결 끊김 시: 표시 중인 수심이 실제와 다를 수 있으므로 회색 처리 */
  function setStale(isStale) {
    root.style.opacity = isStale ? '0.42' : '1';
    root.style.filter = isStale ? 'grayscale(1)' : 'none';
    if (isStale) el.target.textContent = '연결 끊김 — 수심 미확인';
    else paint();
  }

  return { update, setWinchMeta, setStale, setReadOnly };
}
