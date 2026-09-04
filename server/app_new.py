"""
app.py — 라즈베리파이 FastAPI 서버 (CLAUDE.md 5절 2단계).

WebSocket
  /ws/dashboard  대시보드 ↔ 서버. live·측정 레코드 브로드캐스트 + 윈치 명령 수신.
  /ws/ingest     수집기(raspi/feed.py) → 서버.
                 원시 표본 {seq,ec,tds,temp} 수신(접속 시 목업 자동 정지).

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
    tasks = [
        asyncio.create_task(engine.run()),
        asyncio.create_task(store.run_flusher()),
    ]
    if mock is not None:
        tasks.append(asyncio.create_task(mock.run()))
    print(f"[server] DB={config.DB_PATH} mock={mock is not None} "
          f"time_scale={config.TIME_SCALE}", flush=True)
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
            if cmd in COMMANDS:
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
            engine.push_raw({
                "seq": s.get("seq"),
                "ec": s.get("ec"),
                "tds": s.get("tds"),
                "temp": s.get("temp"),
            })
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        engine.ingest_clients = max(0, engine.ingest_clients - 1)


# ═══════════════════════════════════════════════════════════════════════════
# REST
# ═══════════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "state": engine.state,
        "depth_est": round(engine.depth, 3),
        "survey": engine.survey,
        "survey_active": engine.survey_active,
        "site": engine.site,
        "round": engine.round,
        "source": "esp32" if engine.ingest_clients else ("mock" if mock else "none"),
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
