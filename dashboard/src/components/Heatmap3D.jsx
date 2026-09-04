/**
 * Heatmap3D.jsx — (경도 X, 위도 Y, 수심 Z) 3차원 막대 히트맵.
 *
 * 표현 형식 (사용자 확정 2026-08-28 — 산점에서 막대그래프로 교체):
 *   · X/Y 축은 **실제 위도·경도** 를 격자로 나눈 것이다. 축 눈금에 좌표를 그대로 쓴다.
 *   · 막대는 **각 수심 층 바닥에서 값 크기만큼** 위로 솟는다.
 *     높이 스케일은 [0, 위험 임계값] 고정(EC 0~700 / TDS 0~350) — 배치마다 바뀌지 않는다.
 *   · 색은 세 단계뿐이다: 정상(0~280 / 0~140) = 파랑 한 색, 주의 = #B26A00, 위험 = #C62828.
 *     값의 크기는 막대 높이가 이미 선형으로 나타내므로 정상 대역을 그라데이션으로 나누지 않는다
 *     (사용자 확정 2026-08-28).
 *   · 막대를 클릭하면 그 측정 지점이 GPS 지도와 하이라이트 동기화된다.
 *
 * 3초 배치로만 갱신한다(CLAUDE.md 3절). 회전·선택은 로컬 상호작용이라 즉시 반영한다.
 * 이전 산점 구현은 커밋 0f5c738 에 남아 있다 (롤백 지점).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HEATMAP_3D, layerLabel, layerName } from '../config.js';
import { GRID, DEPTHS, cellCenter } from '../stations.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
};

export default function Heatmap3D({ agg, metric, depth, selected, onSelect }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const movedRef = useRef(false);

  const [view, setView] = useState({ az: -0.62, el: 0.52 });   // 방위각 / 고도각(라디안)
  const [size, setSize] = useState({ w: 760, h: 360 });
  const [tip, setTip] = useState(null);

  // agg(측정 지점 집계)는 App 이 3초 배치마다 만들어 지도와 **같은 객체**를 넘겨준다.
  // 두 패널이 같은 station id 를 봐야 클릭 하이라이트가 동기화된다 (stations.js).
  const cfg = HEATMAP_3D.metrics[metric];

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 회전 ──────────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, az: view.az, el: view.el };
    movedRef.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.classList.add('drag');
  }, [view]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) movedRef.current = true;
    setView({
      az: d.az + (e.clientX - d.x) * 0.008,
      el: clamp(d.el + (e.clientY - d.y) * 0.005, 0.12, 1.35)
    });
  }, []);

  const endDrag = useCallback((e) => {
    dragRef.current = null;
    e.currentTarget.classList.remove('drag');
  }, []);

  // ── 투영 ──────────────────────────────────────────────────────────────
  const { project, barMax } = useMemo(() => {
    const { w: W, h: H } = size;
    // 축 눈금(위경도)이 양쪽에 붙으므로 좌우 여백을 뺀다.
    const w = Math.min((W - 165) / 2.9, H * 0.30);
    const h = Math.min(H * 0.40, 280);
    const cx = W / 2 - 10;
    const cy = (H - (2 * w * Math.sin(view.el) + h)) / 2 + w * Math.sin(view.el) + 12;
    const ca = Math.cos(view.az), sa = Math.sin(view.az);
    const p = (x, y, z, lift = 0) => {
      const rx = x * ca - y * sa, ry = x * sa + y * ca;
      return [cx + rx * w, cy + ry * w * Math.sin(view.el) + z * h - lift];
    };
    // 층 간격의 88% 까지만 — 아래 층 막대가 위 층 평면을 뚫지 않게
    return { project: p, barMax: (h / (DEPTHS.length - 1)) * 0.88 };
  }, [size, view]);

  const showAll = depth === 'all';
  const zOf = (d) => (d - DEPTHS[0]) / (DEPTHS[DEPTHS.length - 1] - DEPTHS[0]);
  const cellHalf = 1 / GRID;      // 데이터 좌표(-1~1)에서 격자 반폭

  // ── 막대 ──────────────────────────────────────────────────────────────
  const bars = useMemo(() => {
    const out = [];
    for (const st of agg.list) {
      const x = (st.i / (GRID - 1)) * 2 - 1;
      const y = (st.j / (GRID - 1)) * 2 - 1;
      for (const [dk, cell] of Object.entries(st.depths)) {
        const d = Number(dk);
        const z = zOf(d);
        const on = showAll || Math.abs(d - Number(depth)) < 1e-6;
        // 높이 = 값 비례(선형), 스케일 [0, 위험 임계값] 고정. 확대·왜곡 금지(CLAUDE.md 1절).
        const hh = clamp(cell.v / cfg.dangerMin, 0, 1) * barMax;
        let color;
        if (cell.v > cfg.dangerMin) color = cfg.dangerColor;
        else if (cell.v > cfg.normalMax) color = cfg.overColor;
        else color = cfg.normalColor;
        const s = cellHalf * 0.78;
        const base = [[-s, -s], [s, -s], [s, s], [-s, s]]
          .map(([dx, dy]) => project(x + dx, y + dy, z));
        const top = [[-s, -s], [s, -s], [s, s], [-s, s]]
          .map(([dx, dy]) => project(x + dx, y + dy, z, hh));
        const c = project(x, y, z);
        out.push({
          id: st.id, st, d, v: cell.v, n: cell.n, samples: cell.samples, sd: cell.sd,
          on, color, base, top, cx: c[0], cy: c[1], topY: c[1] - hh
        });
      }
    }
    // 뒤 → 앞 순서로 그린다 (밑면 중심의 화면 y 기준)
    return out.sort((a, b) => a.cy - b.cy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agg, project, showAll, depth, cfg, barMax]);

  const empty = bars.filter((b) => b.on).length === 0;

  const pickAt = useCallback((sx, sy) => {
    // 앞에 그린 것부터 검사 — 막대 몸통(밑면 중심 ~ 꼭대기) 근처면 잡는다.
    for (let n = bars.length - 1; n >= 0; n -= 1) {
      const b = bars[n];
      if (!b.on) continue;
      if (Math.abs(b.cx - sx) < 12 && sy <= b.cy + 7 && sy >= b.topY - 9) return b;
    }
    return null;
  }, [bars]);

  const onMove = useCallback((e) => {
    if (dragRef.current) { setTip(null); return; }
    const rect = svgRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = pickAt(sx, sy);
    setTip(hit ? { x: sx, y: sy, b: hit } : null);
  }, [pickAt]);

  const onClick = useCallback((e) => {
    if (movedRef.current) return;              // 회전 드래그였으면 선택하지 않는다
    const rect = svgRef.current.getBoundingClientRect();
    const hit = pickAt(e.clientX - rect.left, e.clientY - rect.top);
    onSelect?.(hit ? (hit.id === selected ? null : hit.id) : null);
  }, [pickAt, onSelect, selected]);

  // ── 축 눈금 (실제 위경도) ─────────────────────────────────────────────
  const axisTicks = useMemo(() => {
    if (!agg.bounds) return { x: [], y: [] };
    const idx = [0, Math.floor((GRID - 1) / 2), GRID - 1];
    return {
      x: idx.map((i) => ({
        i, pos: (i / (GRID - 1)) * 2 - 1,
        label: cellCenter(agg.bounds, i, 0).lon.toFixed(5)
      })),
      y: idx.map((j) => ({
        j, pos: (j / (GRID - 1)) * 2 - 1,
        label: cellCenter(agg.bounds, 0, j).lat.toFixed(5)
      }))
    };
  }, [agg.bounds]);

  return (
    <>
      <div className="heat-wrap">
        <svg
          ref={svgRef}
          className="heat3d"
          viewBox={`0 0 ${size.w} ${size.h}`}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => { onPointerMove(e); onMove(e); }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={(e) => { endDrag(e); setTip(null); }}
          onClick={onClick}
        >
          {/* 수심 평면 3장 */}
          {DEPTHS.map((d) => {
            const z = zOf(d);
            const on = showAll || Math.abs(d - Number(depth)) < 1e-6;
            const corner = [[-1.08, -1.08], [1.08, -1.08], [1.08, 1.08], [-1.08, 1.08]]
              .map(([x, y]) => project(x, y, z).join(',')).join(' ');
            const grid = [];
            for (let s = 0; s <= GRID; s += 1) {
              const u = -1.08 + (s / GRID) * 2.16;
              const a1 = project(u, -1.08, z), a2 = project(u, 1.08, z);
              const b1 = project(-1.08, u, z), b2 = project(1.08, u, z);
              grid.push(`M${a1} L${a2} M${b1} L${b2}`);
            }
            const lp = project(-1.14, -1.14, z);
            return (
              <g key={`plane-${d}`}>
                <polygon points={corner} fill={on ? '#F4F7FA' : '#FAFAFA'}
                  stroke="#E1E0D9" strokeWidth="1" opacity={on ? 0.92 : 0.45} />
                <path d={grid.join(' ')} stroke="#E8E7E0" strokeWidth="0.7" fill="none"
                  opacity={on ? 1 : 0.5} />
                <text x={lp[0] - 6} y={lp[1] + 4} fontSize="11.5" fontWeight="700"
                  fill={on ? '#12405F' : '#B9C3CA'} textAnchor="end"
                  stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">
                  {layerName(d)}
                </text>
                <text x={lp[0] - 6} y={lp[1] + 16} fontSize="9.5"
                  fill={on ? '#5D7A8C' : '#C9D2D8'} textAnchor="end"
                  stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">
                  {d.toFixed(1)} m
                </text>
              </g>
            );
          })}

          {/* 수직 기둥 */}
          {[[-1.08, -1.08], [1.08, -1.08], [1.08, 1.08], [-1.08, 1.08]].map(([x, y], n) => {
            const p1 = project(x, y, 0), p2 = project(x, y, 1);
            return <line key={`pillar-${n}`} x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]}
              stroke="#E1E0D9" strokeWidth="1" />;
          })}

          {/* 막대 — 옆면 4장 + 윗면 1장으로 입체를 만든다 */}
          {bars.map((b, n) => {
            const isSel = selected && b.id === selected;
            const op = b.on ? (selected && !isSel ? 0.3 : 1) : 0.12;
            return (
              <g key={`bar-${n}`} opacity={op} style={{ cursor: 'pointer' }}>
                {[0, 1, 2, 3].map((k) => {
                  const k2 = (k + 1) % 4;
                  const pts = [b.base[k], b.base[k2], b.top[k2], b.top[k]]
                    .map((p) => p.join(',')).join(' ');
                  return <polygon key={k} points={pts} fill={shade(b.color, k % 2 ? 0.72 : 0.87)} />;
                })}
                <polygon points={b.top.map((p) => p.join(',')).join(' ')}
                  fill={b.color} stroke={isSel ? '#0F2B3D' : 'rgba(15,43,61,.18)'}
                  strokeWidth={isSel ? 2 : 0.7} />
                {isSel && (
                  <polygon points={b.base.map((p) => p.join(',')).join(' ')}
                    fill="none" stroke="#0F2B3D" strokeWidth="1.6" strokeDasharray="3 2" />
                )}
              </g>
            );
          })}

          {/* 축 눈금 — 실제 위경도. 격자와 맞아야 하므로 투영해서 찍는다. */}
          {agg.bounds && (
            <>
              {axisTicks.x.map((t) => {
                const p = project(t.pos, 1.22, 1);
                return (
                  <text key={`xt-${t.i}`} x={clamp(p[0], 34, size.w - 34)} y={p[1] + 4}
                    fontSize="9.5" fill="#7E8C95" textAnchor="middle"
                    stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">
                    {t.label}
                  </text>
                );
              })}
              {axisTicks.y.map((t) => {
                const p = project(1.22, t.pos, 1);
                return (
                  <text key={`yt-${t.j}`} x={Math.min(p[0], size.w - 62)} y={p[1] + 4}
                    fontSize="9.5" fill="#7E8C95" textAnchor="start"
                    stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">
                    {t.label}
                  </text>
                );
              })}
            </>
          )}

          {/* 축 이름은 투영하지 않는다 — 회전해도 눈금과 겹치지 않게 화면 고정 */}
          <text x="12" y={size.h - 10} fontSize="10.5" fontWeight="700" fill="#7E8C95">
            X = 경도(동서) · Y = 위도(남북) · Z = 수심
          </text>
        </svg>

        {empty && (
          <div className="heat-empty">
            이 깊이에서 집계 가능한 레코드가 없습니다 — 측정 레코드는 측정(HOLD) 구간에서만 생성됩니다
          </div>
        )}
        {!empty && agg.bounds?.degenerate && (
          <div className="heat-note">
            측정 지점이 한 곳뿐입니다 — 배를 옮겨 여러 지점을 측정하면 격자가 채워집니다
          </div>
        )}
        {tip && (
          <div className="hm-tip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
            <b>{tip.b.v.toFixed(1)}</b> {cfg.unit}
            {tip.b.sd !== null && <> ± {tip.b.sd.toFixed(1)}</>} · {layerLabel(tip.b.d)}<br />
            {tip.b.st.lat.toFixed(5)}, {tip.b.st.lon.toFixed(5)}<br />
            {tip.b.n > 1 ? `레코드 ${tip.b.n}건 평균 · ` : ''}
            30초 측정 표본 {tip.b.samples}개<br />
            <span className="dim">클릭하면 지도에도 함께 표시됩니다</span>
          </div>
        )}
        <span className="hm-hint">드래그로 회전 · 막대 클릭으로 지점 선택</span>
      </div>

      <div className="legend">
        <span className="sw"><b style={{ background: cfg.normalColor }} />
          정상 0~{cfg.normalMax} {cfg.unit}</span>
        <span className="sw"><b style={{ background: cfg.overColor }} />
          주의 {cfg.normalMax}~{cfg.dangerMin}</span>
        <span className="sw"><b style={{ background: cfg.dangerColor }} />
          위험 &gt;{cfg.dangerMin}</span>
        <span className="sw">막대 높이 = 값 비례(0~{cfg.dangerMin} {cfg.unit}) · fault 집계 제외</span>
      </div>
    </>
  );
}
