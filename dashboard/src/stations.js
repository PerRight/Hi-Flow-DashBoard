/**
 * stations.js — 측정 레코드를 "측정 지점(station)"으로 접는 공통 집계.
 *
 * 3D 히트맵과 GPS 지도가 **같은 지점 목록·같은 id** 를 봐야 클릭 하이라이트를
 * 서로 동기화할 수 있다 (사용자 요청 2026-08-28). 그래서 집계를 한 곳에 두고
 * 두 패널이 결과만 받아 쓴다.
 *
 * 측정 레코드는 2026-08-28 부터 **한 수심 층에 1건**이므로 보통 격자 한 칸 = 레코드 1건이다.
 * 같은 격자에 지점이 여럿 겹치면 그때만 평균이 된다.
 *
 * 격자는 레코드의 실제 위도·경도 min~max 를 GRID×GRID 로 나눈 것이다.
 * 축 눈금도 이 경계값을 그대로 쓰므로 히트맵의 X/Y 는 실제 좌표를 뜻한다.
 * fault 레코드는 집계에서 제외한다(CLAUDE.md 6절).
 */
import { isAggregatable } from './config.js';

export const GRID = 7;
export const DEPTHS = [0.5, 1.0, 1.5];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const stationId = (i, j) => `${i}|${j}`;

/**
 * @returns {{
 *   bounds: {minLat,maxLat,minLon,maxLon,spanLat,spanLon,degenerate:boolean}|null,
 *   list: Array<{id,i,j,lat,lon,n,depths:Object<string,{v:number,n:number}>}>,
 *   byId: Map<string, object>
 * }}
 */
export function buildStations(records, metric) {
  const pts = (records ?? []).filter((r) => isAggregatable(r, metric));
  if (pts.length === 0) return { bounds: null, list: [], byId: new Map() };

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const r of pts) {
    if (r.lat < minLat) minLat = r.lat;
    if (r.lat > maxLat) maxLat = r.lat;
    if (r.lon < minLon) minLon = r.lon;
    if (r.lon > maxLon) maxLon = r.lon;
  }
  // 측점이 한 곳에 몰려 있으면 분모가 0 이 된다 — 최소 폭을 주되 사실을 기록해 둔다.
  const rawLat = maxLat - minLat;
  const rawLon = maxLon - minLon;
  const degenerate = rawLat < 1e-6 && rawLon < 1e-6;
  const spanLat = Math.max(rawLat, 1e-7);
  const spanLon = Math.max(rawLon, 1e-7);

  const acc = new Map();
  for (const r of pts) {
    const i = clamp(Math.floor(((r.lon - minLon) / spanLon) * GRID), 0, GRID - 1);
    const j = clamp(Math.floor(((r.lat - minLat) / spanLat) * GRID), 0, GRID - 1);
    const id = stationId(i, j);
    let st = acc.get(id);
    if (!st) {
      st = { id, i, j, latSum: 0, lonSum: 0, n: 0, depths: {} };
      acc.set(id, st);
    }
    st.latSum += r.lat; st.lonSum += r.lon; st.n += 1;
    const dk = r.depth.toFixed(1);
    const cell = st.depths[dk] ?? (st.depths[dk] = { sum: 0, n: 0, v: 0, samples: 0, sd: null });
    cell.sum += r[metric];
    cell.n += 1;
    cell.v = cell.sum / cell.n;
    // 서버가 붙여 주는 품질 정보 (2026-08-28): samples = 대표값에 쓴 표본 수,
    // *_sd = 그 표본들의 표준편차. 한 격자에 레코드가 하나뿐일 때만 sd 를 그대로 보여준다.
    cell.samples += Number.isFinite(r.samples) ? r.samples : 0;
    cell.sd = cell.n === 1 ? (Number.isFinite(r[`${metric}_sd`]) ? r[`${metric}_sd`] : null) : null;
  }

  const list = [...acc.values()].map((st) => ({
    id: st.id, i: st.i, j: st.j,
    lat: st.latSum / st.n, lon: st.lonSum / st.n,
    n: st.n, depths: st.depths
  }));
  const byId = new Map(list.map((s) => [s.id, s]));

  return {
    bounds: { minLat, maxLat, minLon, maxLon, spanLat, spanLon, degenerate },
    list,
    byId
  };
}

/** 격자 인덱스 i(경도) / j(위도) 의 중심 좌표 — 축 눈금 라벨용 */
export function cellCenter(bounds, i, j) {
  return {
    lon: bounds.minLon + ((i + 0.5) / GRID) * bounds.spanLon,
    lat: bounds.minLat + ((j + 0.5) / GRID) * bounds.spanLat
  };
}
