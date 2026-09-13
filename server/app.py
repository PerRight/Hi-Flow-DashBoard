"""
app.py — 라즈베리파이 FastAPI 서버 (CLAUDE.md 5절 2단계).

WebSocket
  /ws/dashboard  대시보드 ↔ 서버. live·측정 레코드 브로드캐스트 + 윈치 명령 수신.
  /ws/ingest     수집기(raspi/feed.py) → 서버.
                 원시 표본 {seq,ec,tds,temp,lat,lon,gps_fix} 수신(접속 시 목업 자동 정지).
  /ws/mirror     **미러 모드(UWD_MIRROR=1)에서만.** 라즈베리파이 forwarder → 클라우드.
                 Pi 가 판정을 끝낸 live·측정 레코드를 받아 그대로 저장·중계한다.

REST
  GET /health              서버·윈치 상태
  GET /surveys             차수 목록 (조사지·날짜·차수 + 건수)
  GET /sites               최근에 쓴 조사지 이름 목록
  GET /records?survey=N    차수별 측정 레코드
  GET /export?survey=N&format=csv|xlsx   내보내기(백업, CLAUDE.md 6절)

JSON 키는 CLAUDE.md 1절 스키마를 그대로 쓴다. 임의 추가·개명 금지.
"""

import asyncio
import csv
import io
import json
import re
from urllib.parse import quote
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import config
from engine import COMMANDS, Engine
from mock_esp32 import MockESP32
from store import COLUMNS, Store

store = Store(config.DB_PATH)
engine = Engine(store)
mock = MockESP32(engine) if config.USE_MOCK else None


@asynccontextmanager
async def lifespan(_app):
    store.open()
    tasks = [asyncio.create_task(store.run_flusher())]
    if config.MIRROR:
        # 미러는 engine.run()(윈치 상태기계·1 Hz 틱)도 목업도 돌리지 않는다.
        # engine 은 대시보드 클라이언트 관리와 중계에만 쓰인다 (CLAUDE.md 0절).
        print("[server] ** 미러 모드 ** — 상태기계·목업 정지, /ws/mirror 수신만 한다.",
              flush=True)
    else:
        tasks.append(asyncio.create_task(engine.run()))
        if mock is not None:
            tasks.append(asyncio.create_task(mock.run()))
    print(f"[server] DB={config.DB_PATH} mock={mock is not None and not config.MIRROR} "
          f"mirror={config.MIRROR} time_scale={config.TIME_SCALE}", flush=True)
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await store.flush()          # 종료 시 미커밋분 반드시 기록
        store.close()
        print("[server] stopped", flush=True)


app = FastAPI(title="수중드론 수질측정 서버", version="0.2.0", lifespan=lifespan)

# 대시보드는 별도 포트(Vite 5173) 또는 라즈베리파이 핫스팟에서 열린다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════════════════════
# WebSocket
# ═══════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await ws.accept()
    engine.add_client(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            cmd = msg.get("cmd")
            if config.MIRROR:
                # 원격 대시보드는 읽기 전용이다 (CLAUDE.md 0절). UI 가 버튼을
                # 숨기지만, 구버전 대시보드·직접 호출까지 막으려면 서버도 거절해야 한다.
                await ws.send_text(json.dumps(
                    {"type": "ack", "cmd": cmd, "ok": False, "reason": "mirror"}))
            elif cmd in COMMANDS:
                # survey_start 는 site/date/memo 를 함께 받는다 (2026-08-29)
                ok = await engine.command(cmd, msg)
                await ws.send_text(json.dumps({"type": "ack", "cmd": cmd, "ok": bool(ok)}))
            else:
                print(f"[server] 알 수 없는 명령: {cmd!r}", flush=True)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        engine.remove_client(ws)


@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket):
    """수집기(raspi/feed.py) 전용. 접속해 있는 동안 목업은 멈추고 실측만 쓰인다."""
    await ws.accept()
    engine.ingest_clients += 1
    try:
        while True:
            raw = await ws.receive_text()
            try:
                s = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # 원시 스키마만 받는다 (CLAUDE.md 1절)
            raw = {
                "seq": s.get("seq"),
                "ec": s.get("ec"),
                "tds": s.get("tds"),
                "temp": s.get("temp"),
            }
            # GPS (CLAUDE.md 1절 확장, 사용자 확정 2026-09-13).
            # **키가 실제로 온 경우에만** 실어 준다 — 이것이 "이 수집기는 GPS 를
            # 달고 있다" 는 유일한 신호이고, engine 은 이 신호를 받은 뒤로 모의
            # 좌표 생성을 영구히 멈춘다. GPS 를 안 보내는 구버전 feed.py·목업과
            # 구분되지 않으면, FIX 를 못 잡은 상태에서 가짜 보트가 저수지를
            # 돌아다니게 된다 (CLAUDE.md 6절 최악의 버그).
            if "lat" in s or "lon" in s or "gps_fix" in s:
                raw["lat"] = s.get("lat")
                raw["lon"] = s.get("lon")
                raw["gps_fix"] = bool(s.get("gps_fix"))
            engine.push_raw(raw)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        engine.ingest_clients = max(0, engine.ingest_clients - 1)


@app.websocket("/ws/mirror")
async def ws_mirror(ws: WebSocket):
    """라즈베리파이 forwarder → 클라우드 미러 (사용자 확정 2026-09-13).

    핸드셰이크
        → {"type":"hello","token":"…"}
        ← {"type":"ready","max_ts":N}     N 보다 새 레코드만 보내면 된다(백필 기준점)

    이후 스트림
        {"type":"live",   ...}            그대로 중계만 (저장 안 함 — CLAUDE.md 1절)
        {"type":"record", "rec":{…}}      저장 + 중계
        {"type":"survey", "row":{…}}      차수 행 복제 (id 그대로)
        {"type":"backfill","records":[…]} LTE 끊김 구간 재전송 — 저장만, 중계 안 함

    미러가 아니면 아예 열지 않는다. 보트 위 정본 서버에 이 구멍이 열려 있으면
    외부에서 측정 기록을 주입할 수 있다.
    """
    if not config.MIRROR:
        await ws.close(code=4003)
        return
    await ws.accept()

    # 토큰 대조. 첫 메시지가 hello 가 아니거나 토큰이 틀리면 즉시 끊는다.
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=10))
    except Exception:
        await ws.close(code=4400)
        return
    if hello.get("type") != "hello" or hello.get("token") != config.MIRROR_TOKEN:
        print("[mirror] 토큰 불일치 — 연결 거부", flush=True)
        await ws.close(code=4401)
        return

    max_ts = await asyncio.to_thread(store.max_ts)
    await ws.send_text(json.dumps({"type": "ready", "max_ts": max_ts}))
    engine.mirror_clients += 1
    print(f"[mirror] forwarder 접속 — max_ts={max_ts}", flush=True)

    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")

            if kind == "live":
                await engine.relay(msg | {"mirror": True})

            elif kind == "record":
                rec = msg.get("rec") or {}
                if await asyncio.to_thread(store.mirror_record, rec):
                    engine.records_made += 1
                await engine.relay(rec)          # 대시보드는 record 를 그대로 받는다

            elif kind == "survey":
                await asyncio.to_thread(store.mirror_survey, msg.get("row") or {})

            elif kind == "backfill":
                rows = msg.get("records") or []
                n = 0
                for rec in rows:
                    n += await asyncio.to_thread(store.mirror_record, rec)
                engine.records_made += n
                engine.backfilled += n
                print(f"[mirror] 백필 {n}/{len(rows)}건 저장", flush=True)
                await ws.send_text(json.dumps({"type": "backfill_ok", "stored": n}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[mirror] 끊김: {type(exc).__name__}: {exc}", flush=True)
    finally:
        engine.mirror_clients = max(0, engine.mirror_clients - 1)


# ═══════════════════════════════════════════════════════════════════════════
# REST
# ═══════════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    # 미러는 자기 상태기계를 안 돌리므로 engine.state/depth 가 의미 없다.
    # 마지막으로 중계받은 live 를 그대로 보고한다 (Pi 가 정본).
    live = engine.mirror_live if config.MIRROR else None
    return {
        "status": "ok",
        "mirror": config.MIRROR,
        "forwarders": engine.mirror_clients,
        "backfilled": engine.backfilled,
        "state": live.get("state") if live else engine.state,
        "depth_est": live.get("depth_est") if live else round(engine.depth, 3),
        "survey": engine.survey,
        "survey_active": engine.survey_active,
        "site": engine.site,
        "round": engine.round,
        "source": ("forwarder" if engine.mirror_clients else "none") if config.MIRROR
                  else ("esp32" if engine.ingest_clients else ("mock" if mock else "none")),
        "gps": (live.get("gps") if live else "none") if config.MIRROR else engine.gps_state(),
        "gps_lat": (live.get("lat") if live else None) if config.MIRROR else engine.gps_lat,
        "gps_lon": (live.get("lon") if live else None) if config.MIRROR else engine.gps_lon,
        "dashboards": len(engine.clients),
        "live_sent": engine.live_sent,
        "records_made": engine.records_made,
        "pending_rows": store.pending,
        "committed_rows": store.written,
        "db_rows": await asyncio.to_thread(store.count),
    }


@app.get("/surveys")
async def surveys():
    """차수 목록. `active` 는 지금 열려 있는 차수 id (없으면 null)."""
    await store.flush()
    rows = await asyncio.to_thread(store.surveys)
    return {"active": engine.survey, "active_recording": engine.survey_active,
            "site": engine.site, "round": engine.round,
            "surveys": rows}


@app.get("/sites")
async def sites():
    """헤더 조사지 입력란의 자동완성 목록 — 최근에 쓴 이름부터."""
    return {"sites": await asyncio.to_thread(store.recent_sites)}


@app.get("/records")
async def records(survey: int = Query(...), limit: int | None = None):
    """차수별 측정 레코드. 반환 키는 1절 스키마 9개 그대로."""
    await store.flush()
    rows = await asyncio.to_thread(store.records, survey, limit)
    return {"survey": survey, "count": len(rows), "records": rows}


def _disposition(name, ascii_name, ext):
    """Content-Disposition 한 줄 — ASCII 대체 이름 + UTF-8 원본 이름(RFC 5987).

    HTTP 헤더는 latin-1 로만 인코딩된다. 한글 파일명을 raw 로 넣으면 응답 생성 단계에서
    UnicodeEncodeError 가 나 500 이 된다 (2026-09-03 실제로 겪은 버그).
    """
    return (f'attachment; filename="{ascii_name}.{ext}"; '
            f"filename*=UTF-8''{quote(f'{name}.{ext}')}")


@app.get("/export")
async def export(survey: int = Query(...), format: str = "csv"):
    """조사 종료 후 백업용 (CLAUDE.md 6절)."""
    await store.flush()
    rows = await asyncio.to_thread(store.records, survey)
    if not rows:
        raise HTTPException(status_code=404, detail=f"survey {survey}: 레코드 없음")

    # 내보낸 파일만 봐도 어느 저수지 몇 차인지 알 수 있어야 한다 (2026-08-29).
    meta = await asyncio.to_thread(store.survey_meta, survey) or {}
    head = ["site", "survey_date", "round"]
    for r in rows:
        r["site"] = meta.get("site")
        r["survey_date"] = meta.get("survey_date")
        r["round"] = meta.get("round")
    out_cols = head + COLUMNS
    # 파일명: 한글 조사지 이름을 그대로 쓰되, **HTTP 헤더는 ASCII 만 담을 수 있다.**
    # 한글을 raw 로 넣으면 starlette 이 latin-1 인코딩에 실패해 500 이 난다(2026-09-03 수정).
    # RFC 5987 형식으로 filename*(UTF-8 퍼센트 인코딩) 을 주고, 구형 클라이언트용
    # ASCII 대체 이름을 filename= 으로 함께 보낸다.
    name = f"{meta.get('site') or 'survey'}_{meta.get('survey_date') or ''}_{meta.get('round') or survey}차"
    name = re.sub(r"[^\w가-힣.\-]+", "_", name).strip("_") or f"survey_{survey}"
    # ASCII 대체 이름은 차수마다 달라야 한다 — 조사지가 달라도 겹치지 않게 id 를 넣는다.
    ascii_name = (f"survey{survey}_{(meta.get('survey_date') or '').replace('-', '')}"
                  f"_r{meta.get('round') or 1}")

    fmt = format.lower()
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=out_cols, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
        # 엑셀에서 바로 열 수 있도록 BOM 을 붙인다.
        data = buf.getvalue().encode("utf-8-sig")
        return Response(
            content=data, media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": _disposition(name, ascii_name, "csv")},
        )

    if fmt == "xlsx":
        try:
            from openpyxl import Workbook
        except ImportError:
            raise HTTPException(status_code=501,
                                detail="xlsx 미지원 — openpyxl 설치 필요 (CSV 를 사용하세요)")
        wb = Workbook()
        ws = wb.active
        ws.title = f"survey_{survey}"
        ws.append(out_cols)
        for r in rows:
            ws.append([r[c] for c in out_cols])
        bio = io.BytesIO()
        wb.save(bio)
        return Response(
            content=bio.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": _disposition(name, ascii_name, "xlsx")},
        )

    raise HTTPException(status_code=400, detail="format 은 csv 또는 xlsx")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
