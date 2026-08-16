/**
 * SurveySelect.jsx — 측정 차수 선택 드롭다운. REST로 받아온 목록을 그대로 렌더링만 한다.
 */
export default function SurveySelect({ options, value, onChange }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {options.map((o) => (
        <option key={o.no} value={o.no}>{o.label}</option>
      ))}
    </select>
  );
}
