# PROJECT_STATUS.md — 수중드론 수질측정 대시보드

> 이 문서는 프로젝트를 처음 보는 사람/AI가 컨텍스트 없이 이어받을 수 있도록 작성한 진행상황 요약이다.
> **행동 규칙과 기술 명세의 정본은 `CLAUDE.md`** — 충돌 시 CLAUDE.md가 우선한다.
> 최종 갱신: 2026-08-10

## 1. 프로젝트 한 줄 요약

저수지(세종 용암저수지)에서 보트로 센서 프로브를 수심 0.5/1.0/1.5 m에 내려 EC·TDS·수온을 측정하고,
라즈베리파이가 수집·저장한 데이터를 웹 대시보드(게이지·위성지도·3D 히트맵)로 실시간 표시하는 시스템.

## 2. 확정 아키텍처

```
EC/TDS 일체형 센서 (수중 프로브, 보트에서 케이블로 직접 하강)
  │  RS485 Modbus-RTU (주소 5, 9600-8N1, FC03, uint16)
  ▼
라즈베리파이 (조사 보트, USB-RS485 어댑터 /dev/ttyUSB0)
  ├─ raspi/feed.py  : 1초마다 센서 읽기 → {seq,ec,tds,temp} 를 /ws/ingest 로 송신 (가공 금지)
  ├─ server/        : FastAPI — 수심 추정(시간 적분), GPS 병합, SQLite 저장, 브로드캐스트, CSV/XLSX
  ▼  WebSocket(실시간) + REST(누적 조회·내보내기)
대시보드 (브라우저, Vite + 순수 JS + deck.gl + MapLibre + Chart.js)

윈치: 별도 ESP32가 모터를 시간 기반으로 제어 (30초 = 0.5 m). 대시보드/서버와 배선 없음.
      서버는 같은 상수로 병행 적분 — 조작자가 실제 윈치 시작과 동시에 대시보드 명령 입력.
```

주요 확정 이력 (전부 사용자 확정, CLAUDE.md에 반영됨):
- 2026-08-05: 대시보드→서버 채널 2분리(live/측정 레코드), HOLD 구간만 기록, live에 GPS 포함, auto 순차 측정 명령 채택
- 2026-08-10: ESP32 센서 계층 삭제(보트 직접 하강, 라즈베리파이 직결), pH 제외 → EC/TDS 일체형 센서로 교체(ph→tds 스키마 전환), 하강 속도 30초=0.5m
- 2026-08-11: **하이브리드 클라우드 구조 채택** — 라즈베리파이 SQLite가 정본, NCP 클라우드는 미러. LTE 끊김 시 라즈베리파이에 계속 저장하고 재접속 시 백필. 원격 대시보드는 읽기 전용(윈치 명령 불가). HTTPS는 sslip.io + Let's Encrypt.
- 오케스트레이터 확정: 목업 기본 비활성(UWD_MOCK=0), 미장착 센서 판정 제외(UWD_SENSORS), fault 원값 유지·NaN만 null
- 2026-08-16: **프론트엔드 Vite+React로 전환** (기존 "순수 JS, React 금지" 결정 번복). 가독성 개선 목적,
  ws-client.js 재연결 로직·config.js 상수는 그대로 이식, 상태관리 라이브러리는 도입하지 않음(CLAUDE.md 3절)

## 3. 데이터 흐름 (요약 — 정본은 CLAUDE.md 1절)

- 원시(1 Hz): `{"seq":1024, "ec":187.5, "tds":93.0, "temp":21.3}` → `/ws/ingest`
- live(1 Hz, 저장 안 함): `{"type":"live","state","depth_est","ec","tds","temp","lat","lon","status"}`
- 측정 레코드(HOLD에서만, SQLite 저장·히트맵·내보내기): `{"ts","survey","ec","tds","temp","depth","lat","lon","status"}` — depth는 항상 0.5|1.0|1.5
- status: ok | stale(2초 미수신) | fault(범위 밖·NaN). fault도 저장하되 히트맵 집계 제외.

## 4. 폴더 구조

```
CLAUDE.md            행동 지침·기술 명세 정본
PROJECT_STATUS.md    이 문서
raspi/               라즈베리파이 수집기
  ects.py            EC/TDS 센서 리더 (실장착 센서, 검증된 통신 관행 보존)
  feed.py            메인 CLI — 1Hz 폴링→/ws/ingest 송신. --probe/--once/--fake 디버그
  dec890.py          레거시(DEC890 매뉴얼 기준, 실센서와 불일치 — 참고용)
server/              FastAPI 백엔드 (라즈베리파이에서 구동)
  app.py             라우팅: /ws/ingest, /ws/dashboard, /surveys, /records, /export, /health
  engine.py          상태기계·GPS 병합·live/레코드 생성·status 판정
  store.py           SQLite (5초 배치 커밋, 구스키마 감지 시 기동 중단)
  mock_esp32.py      개발용 목업 (UWD_MOCK=1일 때만)
  config.py          상수·환경변수 (UWD_MOCK, UWD_SENSORS, UWD_DB 등)
dashboard/           프론트엔드 (Vite + 순수 JS)
  src/ws-client.js   서버 연결 (재연결 지수 백오프 최대 10초 — 수정 금지)
  src/panels/        gauges(EC·TDS·수온), depth, charts, map(위성+궤적), heatmap(EC, 깊이 탭 3개)
  src/mock-stream.js 1단계 폴백 목업 (미사용, 보존)
세종 용암저수지 *.xlsx  실측 수질 데이터 76건 (2010~2026) — 임계값·목업 범위의 근거
EC센서 유저 메뉴얼.pdf  DEC890 매뉴얼 (실센서와 불일치 — 참고용)
3D 히트맵 예시.png      목표 히트맵 형태 (격자 막대, 높이=값)
```

## 5. 단계별 진행 상황 (CLAUDE.md 5절 기준)

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 목업 스트림 + 대시보드 전 패널 | ✅ 완료 (리뷰 승인) |
| 2 | FastAPI WebSocket/REST + SQLite, 왕복 검증 | ✅ 완료 (리뷰 승인) |
| 3 | 실센서 연동 + 교정 | 🔶 진행 중 — 아래 참조 |
| 4 | 현장(저수지) 시험 | ⬜ 대기 |

3단계 세부:
- ✅ 라즈베리파이 수집기(ects.py/feed.py) 작성·리뷰 승인 — 사용자 제공 검증 코드 기준
- ✅ ph→tds 전 계층 전환 (서버·DB·대시보드·내보내기)
- ✅ **레지스터 맵 실측 검증** (2026-08-13) — TDS/EC=0.5 세 시료 일치, CLAUDE.md 4절에 기록
- ✅ **라즈베리파이 환경 구성** — venv, 의존성, `feed.py --fake` 왕복 점검 성공(레코드 120건 저장 확인)
- ⬜ **USB-RS485 어댑터 연결** — 현재 `/dev/ttyUSB0` 미인식(어댑터 미장착). 이후 `feed.py --once` 확인
- ⬜ 1413 µS/cm 표준액 대조 검증 ±5% (이 센서는 교정 레지스터 정보 없음 → 대조 검증으로 갈음)
- ⬜ **온도 보정 여부 판정** — 표준액을 25 ℃/30 ℃ 두 온도에서 측정 (CLAUDE.md 4절 미해결 항목)
- ⬜ 1시간 연속 송신 무손실 시험

클라우드(NCP) 구축 — 2026-08-13 완료:
- ✅ VPC/Subnet/ACG, Ubuntu 24.04 micro 서버(mi1-g3), 공인 IP 101.79.22.64
- ✅ GitHub 저장소 `PerRight/Hi-Flow-DashBoard` (Private) — 두 대가 같은 저장소를 clone
- ✅ systemd(`uwd-server`) + nginx 리버스 프록시 + Let's Encrypt HTTPS
- ✅ `https://101.79.22.64.sslip.io` 에서 대시보드 동작, `wss://` 정상 (config.js 프로토콜 자동 전환)
- ⚠️ 목업 시험 데이터는 삭제 완료 — 이후 `UWD_MOCK=0` 유지

## 6. 실행 방법 (개발 노트북 / 라즈베리파이 동일)

```bash
# 서버 (server/ 폴더)          # 개발 시연은 UWD_MOCK=1 uvicorn ...
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000

# 수집기 (raspi/ 폴더, 라즈베리파이)
python3 feed.py --once     # 센서 단독 1회 확인
python3 feed.py --probe    # 레지스터 원시 덤프 (값 이상할 때)
python3 feed.py            # 1Hz 상시 송신

# 대시보드 (dashboard/ 폴더)
npm run dev                # 개발 / npm run build → dist/
```

주의: 목업은 기본 꺼짐(UWD_MOCK=1일 때만, 정확히 "1"만 유효). 옛 DB(ph 컬럼)가 있으면 서버가 안내 후 기동 중단.

## 7. 향후 계획

### 하드웨어 대기 중 (어댑터 꽂으면 바로)
1. `feed.py --once` / `--probe` 로 실측값 확인 → 이상 시 레지스터 맵 조정
2. 표준액 1413 µS/cm **25 ℃** 대조 ±5% — 초과 시 벤더 문의, 결과를 CLAUDE.md 4절에 기입
3. **같은 표준액 30 ℃ 재측정** → 온도 보정 유무 판정 (CLAUDE.md 4절 미해결 항목)
   - "보정 없음"으로 나오면 대응 방안을 사용자에게 제시 후 확정 (코드 임의 보정 금지)
4. 1시간 연속 시험 (레코드 무손실, stale 복구 포함)

### 사용자 결정 대기 중
- **`stale_reason` 필드 추가 여부** (1절 스키마 변경 → 2절에 따라 승인 필요)
  - 목적: 원격 대시보드에서 "센서 고장 / 수집기 정지 / LTE 끊김"을 구분해 표시
  - 값: `null | "no_sensor" | "no_feed" | "no_boat"`, 기존 9개 키는 불변
  - 미승인 시 세 상황이 모두 "연결 끊김"으로만 표시되어, 멀쩡한 조사를 중단할 위험이 남는다

### 클라우드 연동 (승인 후 착수)
5. **forwarder 작성** (라즈베리파이 → 클라우드) — 봉투 방식 `{type, rec_id, payload}`,
   재접속 시 워터마크 기준 백필. `live` 는 백필하지 않음(1절 "저장 안 함")
6. **클라우드 미러 모드** — 수신·저장·중계만. 수심 추정·status 재계산 금지(0절 경계)
7. **클라우드 워치독** — forwarder 링크 끊김을 감지해 원격에 "보트 연결 끊김" 명시
8. 원격 대시보드 **읽기 전용화** — 윈치 명령 UI 비활성 (0절 경계)

### 현장 준비 (4단계)
9. **VWorld 위성 타일 키 발급** — 현재 키 미설정으로 OSM 대체 중.
   물 위에서 보트 위치를 확인하려면 위성 영상이 필요 (3절)
10. GPS 모듈 실연동 (현재 모의 GPS — engine.py의 GPS 공급부 교체)
11. 라즈베리파이 핫스팟 AP 구성 + systemd 자동 시작 (`deploy/raspi/` 유닛 사용)
12. 저수지 실조사: 끊김 복구, stale 표시, 1회 조사 전체 기록 무손실 확인
13. 조사 종료 백업 절차 확립 (SQLite + 차수별 CSV)

### 선택 개선 (우선순위 낮음)
- 윈치 ESP32 → 서버 "하강 시작" 신호 자동 전달 (현재는 조작자 병행 입력)
- ASCENT_RATE 실측 후 상수 확정 (현재 하강과 동일값 가정)
- 수압센서(MS5837) 도입 시 시간 적분 → 실측 수심 교체 (CLAUDE.md 1절 참조)
- 대시보드 코드 스플리팅 (번들 549 kB gzip — 현재 문제 없음)
- 클라우드 배포에 Deploy key 도입 (현재 PAT — 만료 시 재발급 필요)
- `tools/` 의 레지스터 조사 스크립트를 raspi 진단 도구로 정리

## 9. 운영 규칙 (사고 방지)

- **시험 후에는 반드시 DB를 지운다.** `--fake`·`UWD_MOCK` 으로 만든 레코드가 정본 SQLite에
  남으면 진짜 측정과 구분되지 않는다. `rm -f server/data/records.db`
- **`UWD_MOCK` 은 두 대 모두 0 이다.** 켜진 채 현장에 나가면 feed 가 죽는 순간
  가짜 값이 `status:"ok"` 로 표시된다 (6절 최악의 버그).
- 코드 갱신은 `git pull` — 라즈베리파이 `~/Hiflow`, 클라우드 `~/app`.
  대시보드를 고쳤으면 클라우드에서 `npm run build` 를 다시 돌려야 반영된다.

## 8. 작업 방식 (CLAUDE.md 7절 — 2026-08-10 개편)

- **Opus 5**: 기획·계획 수립 + 코드 작성. 스키마·상수·아키텍처 변경은 코드 작성 전 사용자 확인.
- **Sonnet 5**: 코드 리뷰 + 수정 반영분 재검토. 리뷰 통과 전 단계 완료 처리 금지.
- 확정 사항은 날짜와 함께 CLAUDE.md에 기록.
