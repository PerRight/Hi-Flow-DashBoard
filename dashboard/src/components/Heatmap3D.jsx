/**
 * Heatmap3D.jsx — (X, Y, 수심) 3차원 산점 히트맵.
 *
 * 형식 채택: design/UI_REQUIREMENTS.md §3.10 (사용자 확정 2026-08-26).
 *   깊이별 평면 슬라이스(deck.gl GridLayer)를 대체한다 — 세 수심층을 한 화면에 쌓아 보여준다.
 *
 * 값 표현 규칙 (CLAUDE.md 1절 — 임계값·컬러 도메인은 불변):
 *   · 정상 도메인 안 : 파랑 단일 순차 램프 + 사각형
 *   · 도메인 초과(주의) : #B26A00 다이아몬드 / 위험 임계 초과 : #C62828 다이아몬드
 *   · 마커 크기 = 값 비례(선형). 강조를 위한 확대·왜곡 금지.
 *   · fault 레코드는 집계에서 제외한다(6절). stale 구간은 애초에 레코드가 없다.
 *
 * 3초 배치로만 갱신한다(CLAUDE.md 3절). 회전은 로컬 상호작용이라 즉시 반영한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HEATMAP_3D, isAggregatable } from '../config.js';

const GRID = 7;                    // 격자 7×7 (동서 × 남북)
const DEPTHS = [0.5, 1.0, 1.5];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 측정 레코드를 (i, j, depth) 격자 평균으로 접는다. */
function buildCells(records, metric) {
  const pts = records.filter((r) => isAggregatable(r, metric));
  if (pts.length === 0) return [];

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const r of pts) {
    if (r.lat < minLat) minLat = r.lat;
    if (r.lat > maxLat) maxLat = r.lat;
    if (r.lon < minLon) minLon = r.lon;
    if (r.lon > maxLon) maxLon = r.lon;
  }
  // 측점이 한 곳에 몰려 있으면 분모가 0이 된다 — 최소 폭을 준다.
  const spanLat = Math.max(maxLat - minLat, 1e-7);
  const spanLon = Math.max(maxLon - minLon, 1e-7);

  const acc = new Map();
  for (const r of pts) {
    const i = clamp(Math.floor(((r.lon - minLon) / spanLon) * GRID), 0, GRID - 1);
    const j = clamp(Math.floor(((r.lat - minLat) / spanLat) * GRID), 0, GRID - 1);
    const key = `${i}|${j}|${r.depth}`;
    const cur = acc.get(key);
    if (cur) { cur.sum += r[metric]; cur.n += 1; }
    else acc.set(key, { i, j, d: r.depth, sum: r[metric], n: 1 });
  }
  return [...acc.values()].map((c) => ({ i: c.i, j: c.j, d: c.d, v: c.sum / c.n, n: c.n }));
}

export default function Heatmap3D({ batchSeq, recordsRef, metric, depth }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const [view, setView] = useState({ az: -0.62, el: 0.52 });   // 방위각 / 고도각(라디안)
  const [size, setSize] = useState({ w: 760, h: 360 });
  const [cells, setCells] = useState([]);
  const [tip, setTip] = useState(null);

  const cfg = HEATMAP_3D.metrics[metric];

  // 3초 배치 갱신 — recordsRef 는 훅이 채워 둔 스냅샷이다.
  useEffect(() => {
    setCells(buildCells(recordsRef.current ?? [], metric));
  }, [batchSeq, recordsRef, metric]);

  // 크기 추적 (부모 ResizeObserver 와 별개로 자기 박스를 본다)
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
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.classList.add('drag');
  }, [view]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
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
  const { box, project } = useMemo(() => {
    const { w: W, h: H } = size;
    const w = Math.min((W - 90) / 2.8, H * 0.30);   // 좌측 수심 라벨 자리 확보
    const h = Math.min(H * 0.42, 300);
    const b = {
      cx: W / 2 + 16,
      w,
      h,
      cy: (H - (2 * w * Math.sin(view.el) + h)) / 2 + w * Math.sin(view.el)
    };
    const ca = Math.cos(view.az), sa = Math.sin(view.az);
    const p = (x, y, z) => {
      const rx = x * ca - y * sa, ry = x * sa + y * ca;
      return [b.cx + rx * b.w, b.cy + ry * b.w * Math.sin(view.el) + z * b.h];
    };
    return { box: b, project: p };
  }, [size, view]);

  const showAll = depth === 'all';
  const shown = showAll ? cells : cells.filter((c) => Math.abs(c.d - Number(depth)) < 1e-6);
  const zOf = (d) => (d - DEPTHS[0]) / (DEPTHS[DEPTHS.length - 1] - DEPTHS[0]);

  // ── 마커 ──────────────────────────────────────────────────────────────
  const marks = useMemo(() => {
    const [lo, hi] = cfg.colorDomain;
    return cells
      .map((c) => {
        const x = (c.i / (GRID - 1)) * 2 - 1;
        const y = (c.j / (GRID - 1)) * 2 - 1;
        const [px, py] = project(x, y, zOf(c.d));
        const on = showAll || Math.abs(c.d - Number(depth)) < 1e-6;
        // 크기 = 값 비례(선형). CLAUDE.md 1절: 값을 왜곡하는 확대 금지.
        const tt = clamp((c.v - lo) / (hi - lo), 0, 1.4);
        const size2 = 5 + tt * 9;
        let color, diamond = false;
        if (c.v > cfg.dangerMin) { color = cfg.dangerColor; diamond = true; }
        else if (c.v > hi) { color = cfg.overColor; diamond = true; }
        else {
          const ramp = HEATMAP_3D.ramp;
          const k = Math.round(((c.v - lo) / (hi - lo)) * (ramp.length - 1));
          color = ramp[clamp(k, 0, ramp.length - 1)];
        }
        return { ...c, px, py, size: size2, color, diamond, on };
      })
      .sort((a, b) => a.py - b.py);   // 뒤 → 앞 순서로 그린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, project, showAll, depth, cfg]);

  const onMove = useCallback((e) => {
    if (dragRef.current) { setTip(null); return; }
    const rect = svgRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = [...marks].reverse()
      .find((k) => k.on && Math.abs(k.px - sx) < 8 && Math.abs(k.py - sy) < 8);
    setTip(hit ? { x: sx, y: sy, m: hit } : null);
  }, [marks]);

  const empty = shown.length === 0;

  return (
    <>
      <div className="heat-wrap" ref={wrapRef}>
        <svg
          ref={svgRef}
          className="heat3d"
          viewBox={`0 0 ${size.w} ${size.h}`}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => { onPointerMove(e); onMove(e); }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={(e) => { endDrag(e); setTip(null); }}
        >
          {/* 수심 평면 3장 */}
          {DEPTHS.map((d) => {
            const z = zOf(d);
            const on = showAll || Math.abs(d - Number(depth)) < 1e-6;
            const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
              .map(([x, y]) => project(x, y, z).join(',')).join(' ');
            const grid = [];
            for (let s = 1; s < 4; s++) {
              const u = -1 + s * 0.5;
              const a1 = project(u, -1, z), a2 = project(u, 1, z);
              const b1 = project(-1, u, z), b2 = project(1, u, z);
              grid.push(`M${a1} L${a2} M${b1} L${b2}`);
            }
            const lp = project(-1.04, -1.04, z);
            return (
              <g key={`plane-${d}`}>
                <polygon points={corner} fill={on ? '#F4F7FA' : '#FAFAFA'}
                  stroke="#E1E0D9" strokeWidth="1" opacity={on ? 0.9 : 0.5} />
                <path d={grid.join(' ')} stroke="#E8E7E0" strokeWidth="0.8" fill="none" />
                <text x={lp[0] - 6} y={lp[1] + 4} fontSize="11" fontWeight="700"
                  fill={on ? '#12405F' : '#B9C3CA'} textAnchor="end"
                  stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">
                  {d.toFixed(1)} m
                </text>
              </g>
            );
          })}

          {/* 수직 기둥 */}
          {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y], n) => {
            const p1 = project(x, y, 0), p2 = project(x, y, 1);
            return <line key={`pillar-${n}`} x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]}
              stroke="#E1E0D9" strokeWidth="1" />;
          })}

          {/* 셀 마커 */}
          {marks.map((k, n) => (
            <rect key={`m-${n}`} x={k.px - k.size / 2} y={k.py - k.size / 2}
              width={k.size} height={k.size}
              rx={k.diamond ? undefined : 1}
              transform={k.diamond ? `rotate(45 ${k.px} ${k.py})` : undefined}
              fill={k.color} opacity={k.on ? 0.92 : 0.16} />
          ))}

          {/* 축 라벨 */}
          {(() => {
            const xl = project(0, -1.5, 1), yl = project(1.5, 0, 1);
            return (
              <>
                <text x={xl[0]} y={xl[1] + 14} fontSize="11" fill="#898781" textAnchor="middle"
                  stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">동서 X</text>
                <text x={yl[0]} y={yl[1] + 14} fontSize="11" fill="#898781" textAnchor="middle"
                  stroke="#FCFCFB" strokeWidth="3" paintOrder="stroke">남북 Y</text>
              </>
            );
          })()}
        </svg>

        {empty && (
          <div className="heat-empty">
            이 깊이에서 집계 가능한 레코드가 없습니다 — 측정 레코드는 HOLD 구간에서만 생성됩니다
          </div>
        )}
        {tip && (
          <div className="hm-tip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
            <b>{tip.m.v.toFixed(1)}</b> {cfg.unit} · 수심 {tip.m.d.toFixed(1)} m<br />
            격자 ({tip.m.i + 1}, {tip.m.j + 1}) · 레코드 {tip.m.n}건 평균
          </div>
        )}
        <span className="hm-hint">드래그로 회전</span>
      </div>

      <div className="legend">
        <span className="sw num">{cfg.colorDomain[0]}</span>
        <span className="ramp" />
        <span className="sw num">{cfg.colorDomain[1]} {cfg.unit}</span>
        <span className="sw"><b className="dia" style={{ background: cfg.overColor }} />
          주의 {cfg.colorDomain[1]}~{cfg.dangerMin}</span>
        <span className="sw"><b className="dia" style={{ background: cfg.dangerColor }} />
          위험 &gt;{cfg.dangerMin}</span>
        <span className="sw">마커 크기 = 값 비례(선형) · fault 집계 제외</span>
      </div>
    </>
  );
}
