/**
 * SurveyPanel.jsx — 조사 차수 관리 (센서 실측값 카드 아래, 사용자 요청 2026-08-29).
 * 화면에 보이는 카드 제목은 "수질 측정 시작" 이다 (2026-09-06) — 내부 개념 이름은 계속 "차수".
 *
 * 규칙 (사용자 확정 2026-08-29):
 *   · 차수는 **조작자가 "차수 시작"을 눌러야** 생긴다. 전원만 켜져 있으면 아무것도 안 생긴다.
 *   · 차수 번호는 **조사지 + 날짜** 안에서만 1,2,3… 으로 올라간다.
 *     저수지를 옮기면 다시 1차다 — 다른 저수지에서 4·5·6차가 되지 않는다.
 *   · 번호를 매기는 주체는 서버다. 여기 표시하는 "다음 N차"는 미리보기일 뿐이다.
 */

const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export default function SurveyPanel({
  site, onSite, siteOptions, rows, winchMeta, onStart, onEnd, stale
}) {
  const open = !!winchMeta.surveyOpen;
  // 원격(클라우드 미러) 화면 — 차수 조작은 보트 위에서만 (CLAUDE.md 0절, 2026-09-13)
  const remote = !!winchMeta.mirror;
  const today = todayStr();
  const name = (site ?? '').trim();

  // 같은 조사지·같은 날짜의 차수만 센다 (서버와 같은 규칙).
  const sameDay = rows.filter((r) => r.site === name && r.survey_date === today);
  const nextRound = sameDay.reduce((m, r) => Math.max(m, r.round), 0) + 1;
  const current = open ? rows.find((r) => r.survey === winchMeta.survey) : null;

  const canStart = !remote && !open && name.length > 0 && !stale;
  const submit = (e) => {
    e.preventDefault();
    if (canStart) onStart(name);
  };

  return (
    <form className="survey-box" onSubmit={submit}>
      <div className="survey-head">
        <span className="survey-title">수질 측정 시작</span>
        <span className={`state-badge ${open ? 'state-DONE' : ''}`}>
          {open ? `${winchMeta.round}차 측정 중` : '차수 없음'}
        </span>
      </div>

      <input
        className="site-input"
        list="site-options"
        value={site}
        onChange={(e) => onSite(e.target.value)}
        placeholder="저수지 이름을 적어주세요."
        readOnly={open || remote}
        aria-label="조사지 이름"
      />
      <datalist id="site-options">
        {siteOptions.map((s) => <option key={s} value={s} />)}
      </datalist>

      <div className="survey-info num">
        {open && current
          ? `${current.site} · ${current.survey_date} · 지점 ${current.stations ?? 0}곳 · 레코드 ${current.count ?? 0}건`
          : name
            ? `${today} · ${name}에서 오늘 ${sameDay.length}차까지 진행`
            : `${today} 조사지를 먼저 적어주세요.`}
      </div>

      {!remote && (
        <div className="survey-btns">
          <button type="submit" className="btn" disabled={!canStart}>
            {open ? '차수 진행 중' : (name ? `${nextRound}차 시작` : '차수 시작')}
          </button>
          <button type="button" className="btn sec" onClick={onEnd} disabled={!open}>
            차수 종료
          </button>
        </div>
      )}

      {/* 안내 문구는 두 줄로 끊어 준다 (사용자 확정 2026-09-06) — 한 덩어리면 읽히지 않는다. */}
      <p className="note note-lines">
        {remote ? (
          <>
            <span>원격 화면입니다 — 보기만 할 수 있습니다.</span>
            <span>차수 시작·종료는 보트 위 대시보드에서 합니다.</span>
          </>
        ) : open ? (
          <>
            <span>차수를 종료해야 다음 차수를 시작할 수 있습니다.</span>
            <span>종료하면 진행 중이던 측정은 기록되지 않습니다.</span>
          </>
        ) : (
          <>
            <span>조사지를 적고 차수를 시작해야 측정이 기록됩니다.</span>
            <span>저수지를 바꿔 적으면 해당 지점의 1차부터 다시 시작합니다.</span>
          </>
        )}
      </p>
    </form>
  );
}
