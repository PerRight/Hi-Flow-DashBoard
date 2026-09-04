/**
 * Rail.jsx — 좌측 레일 (240 px).
 *
 * UI_REQUIREMENTS §4·§4.1 (사용자 확정 2026-08-26):
 *   표시 항목(EC/TDS) 선택은 이 레일이 단독으로 소유한다.
 *   히트맵 패널 안에 같은 탭을 두지 않는다 — 한 선택을 두 곳에서 하면 어긋난다.
 * 깊이 슬라이스도 여기서 고르고, 히트맵·범례·센서 강조가 모두 이 선택을 따른다.
 */
import { SERVER, DEPTH_LEVELS, layerName } from '../config.js';

const METRICS = [
  { key: 'ec', label: 'EC', unit: 'µS/cm' },
  { key: 'tds', label: 'TDS', unit: 'ppm' }
];

const comma = (n) => n.toLocaleString('ko-KR');

export default function Rail({ metric, onMetric, depth, onDepth, counts, survey }) {
  const total = DEPTH_LEVELS.reduce((a, d) => a + (counts[d.toFixed(1)] ?? 0), 0);
  const exportUrl = (fmt) => `${SERVER.http}/export?survey=${survey}&format=${fmt}`;
  // 레코드가 없는 차수는 서버가 404 를 준다 — 버튼을 아예 잠근다.
  const canExport = survey !== null && survey !== undefined && total > 0;

  return (
    <div className="a-rail">
      <section className="panel">
        <h2 className="panel-title">표시 항목</h2>
        <div className="panel-body">
          <div className="tabs" role="tablist">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                className="tab"
                role="tab"
                aria-selected={metric === m.key}
                onClick={() => onMetric(m.key)}
              >
                {m.label} <span className="cnt">{m.unit}</span>
              </button>
            ))}
          </div>
          <p className="note">히트맵 데이터 선택</p>
        </div>
      </section>

      <section className="panel" style={{ flex: '1 1 auto' }}>
        <h2 className="panel-title">수심 선택</h2>
        <div className="panel-body">
          <div className="tabs" role="tablist">
            <button
              type="button"
              className={`tab${total === 0 ? ' zero' : ''}`}
              role="tab"
              aria-selected={depth === 'all'}
              onClick={() => onDepth('all')}
            >
              전체 (3층) <span className="cnt">{comma(total)}</span>
            </button>
            {DEPTH_LEVELS.map((d) => {
              const key = d.toFixed(1);
              const n = counts[key] ?? 0;
              return (
                <button
                  key={key}
                  type="button"
                  className={`tab${n === 0 ? ' zero' : ''}`}
                  role="tab"
                  aria-selected={depth === key}
                  onClick={() => onDepth(key)}
                >
                  {layerName(d)} <span className="lv">{key} m</span> <span className="cnt">{comma(n)}</span>
                </button>
              );
            })}
          </div>

          <div className="divider" />

          {/* 내보내기는 서버 REST 를 그대로 연다 (GET /export?survey=N&format=…) */}
          <a
            className="btn export"
            href={canExport ? exportUrl('csv') : undefined}
            aria-disabled={!canExport}
          >
            CSV 내보내기
          </a>
          <a
            className="btn export"
            href={canExport ? exportUrl('xlsx') : undefined}
            aria-disabled={!canExport}
          >
            XLSX 내보내기
          </a>
          <p className="note">
            {canExport ? '데이터 표시 항목 선택 및 내보내기' : '내보낼 측정 레코드가 아직 없습니다'}
          </p>
        </div>
      </section>
    </div>
  );
}
