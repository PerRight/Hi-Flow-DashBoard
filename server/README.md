# server — 라즈베리파이 백엔드 (CLAUDE.md 5절 2단계)

FastAPI + SQLite. 수집기(raspi/feed.py) 원시 표본 `{seq,ec,tds,temp}` 를 받아
수심 상태기계·GPS 병합·저장·브로드캐스트를 담당한다.

## 실행

```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000     # server/ 폴더에서 실행 (목업 없음 = 실기용)

# 개발·시연(하드웨어 없이 대시보드를 돌려볼 때)은 목업을 명시적으로 켠다
UWD_MOCK=1 uvicorn app:app --host 0.0.0.0 --port 8000
```

대시보드는 별도 터미널에서 `cd ../dashboard && npm run dev` (기본으로 `:8000` 서버에 붙는다).

## 환경변수

| 변수 | 기본 | 설명 |
|---|---|---|
| `UWD_DB` | `server/data/records.db` | SQLite 경로 |
| `UWD_MOCK` | `0` | **기본 비활성.** `1` 이면 목업 센서 스트림을 켠다 — **개발·시연에서만 명시적으로 `UWD_MOCK=1`** 을 붙인다 |
| `UWD_SENSORS` | `ec,tds,temp` | 실제로 장착된 센서 목록(쉼표 구분). 여기 없는 항목은 `status` 판정에서 제외되고 언제나 `null` 로 송신·NULL 로 저장된다. **EC/TDS 일체형 센서는 3항목을 모두 주므로 지정할 일이 없다** |
| `UWD_TIME_SCALE` | `1.0` | **시험 전용** 시간 배속. 물리 상수는 그대로, 상태기계만 빠르게 진행. 현장에서는 반드시 1.0 |

### `UWD_MOCK`

기본이 `0` 인 이유는 CLAUDE.md 6절이다. 실기 feed 가 끊긴 순간 목업이 조용히 이어받으면
**가짜 값이 `status:"ok"` 로 대시보드에 뜬다.** 그래서 목업은 "켜야 켜지는" 쪽이 기본이고,
켜져 있더라도 `/ws/ingest` 에 실기가 접속하면 자동으로 침묵한다.
`GET /health` 의 `source` 로 확인한다 — `esp32`(실측) / `mock`(목업) / `none`(입력 없음).

### `UWD_SENSORS`

미장착 센서 때문에 전체가 `fault` 로 물드는 것을 막는 장치다.

**지금 구성(EC/TDS 일체형 센서)에서는 지정할 필요가 없다.** 센서 하나가 `ec`·`tds`·`temp`
세 값을 모두 주므로 기본값 `ec,tds,temp` 그대로 두면 된다. 아래는 특정 항목이 고장 나
계속 `fault` 가 뜰 때의 임시 수단이다.

```bash
UWD_SENSORS=ec,temp uvicorn app:app --host 0.0.0.0 --port 8000   # TDS 만 빼고 판정
```

- 판정 참여: 나열한 항목만. 전부 정상 범위면 `status:"ok"`.
- 제외한 항목은 입력에 값이 실려 와도 **무시하고 항상 `null`** 로 내보내며 DB 에도 NULL.
- 공백은 허용(`ec, temp`), 대소문자 무시, 유효 항목(`ec`/`tds`/`temp`)만 인정하고
  나머지는 경고 로그 후 무시한다. 전부 비면 기본값 `ec,tds,temp` 로 되돌린다.
- 장착 항목의 판정 규칙은 그대로다 — NaN·미수신은 `null`, 범위 밖은 **원값을 유지한 채** `fault`.

### DB 스키마 변경 (2026-08-10) — 기존 개발 DB 와 비호환

`records` 테이블의 `ph` 컬럼이 `tds` 로 바뀌었다. **마이그레이션 코드는 없다.**
구스키마 DB 를 가리킨 채로 띄우면 서버가 경로·컬럼 목록과 함께 안내를 출력하고 기동을
중단한다(조용히 덮어쓰지 않는다 — CLAUDE.md 6절).

```bash
mv server/data/records.db server/data/records.db.ph.bak     # ① 백업 후 삭제
UWD_DB=/path/records_tds.db uvicorn app:app                 # ② 새 경로 사용
```

백업본의 과거 데이터가 필요하면 `sqlite3` 로 직접 조회한다.

## 엔드포인트

- `ws://<host>:8000/ws/dashboard` — live(1 Hz) · 측정 레코드 브로드캐스트, 명령 수신
  `{"cmd":"down"|"stop"|"up"|"auto"|"survey_start"|"survey_end"}`
- `ws://<host>:8000/ws/ingest` — 수집기(raspi/feed.py) → 서버
  `{"seq":1,"ec":187.5,"tds":93.0,"temp":21.3}` (접속 중에는 목업이 자동으로 멈춘다)
- `GET /health` / `GET /surveys` / `GET /records?survey=N` / `GET /export?survey=N&format=csv|xlsx`

## 구조

| 파일 | 역할 |
|---|---|
| `config.py` | CLAUDE.md 1절 상수 (dashboard/src/config.js 와 동일해야 함) |
| `mock_esp32.py` | 목업 센서 — ESP32 원시 스키마만 큐에 공급 |
| `engine.py` | 윈치 상태기계 · GPS 병합 · live/레코드 생성 · 브로드캐스트 |
| `store.py` | SQLite. **5초 단위 트랜잭션 배치 커밋**(SD카드 마모 최소화) |
| `app.py` | FastAPI 라우팅 |

## 규칙 메모

- live 는 저장하지 않는다. 저장 대상은 HOLD 구간의 측정 레코드뿐이며 `depth` 는 항상 0.5/1.0/1.5.
- 원시 표본 2초 이상 미수신 → live `status:"stale"`. 이 구간에는 측정 레코드를 만들지 않는다.
- NaN·범위 밖 값은 `status:"fault"` 로 **저장은 하되** 히트맵 집계에서는 제외(대시보드 담당).
- `status` 판정에 참여하는 항목은 `UWD_SENSORS` 로 제한된다. 미장착 항목은 항상 `null`/NULL.
- 서버 재기동 시 기존 DB 를 이어쓰고 차수는 `MAX(survey)+1` 부터 시작한다.
