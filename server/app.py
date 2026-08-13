"""
app.py — 라즈베리파이 FastAPI 서버 (CLAUDE.md 5절 2단계).

WebSocket
  /ws/dashboard  대시보드 ↔ 서버. live·측정 레코드 브로드캐스트 + 윈치 명령 수신.
  /ws/ingest     수집기(raspi/feed.py) → 서버.
                 원시 표본 {seq,ec,tds,temp} 수신(접속 시 목업 자동 정지).

REST
  GET /health              서버·윈치 상태
  GET /surveys             차수 목록 + 건수
  GET /records?survey=N    차수별 측정 레코드
  GET /export?survey=N&format=csv|xlsx   내보내기(백업, CLAUDE.md 6절)

JSON 키는 CLAUDE.md 1절 스키마를 그대로 쓴다. 임의 추가·개명 금지.
"""

import asyncio
import csv
import io
import json
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
                await engine.command(cmd)
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
    """차수 목록 + 건수. `active` 는 지금 기록 중인 차수."""
    await store.flush()
    rows = await asyncio.to_thread(store.surveys)
    return {"active": engine.survey, "active_recording": engine.survey_active,
            "surveys": rows}


@app.get("/records")
async def records(survey: int = Query(...), limit: int | None = None):
    """차수별 측정 레코드. 반환 키는 1절 스키마 9개 그대로."""
    await store.flush()
    rows = await asyncio.to_thread(store.records, survey, limit)
    return {"survey": survey, "count": len(rows), "records": rows}


@app.get("/export")
async def export(survey: int = Query(...), format: str = "csv"):
    """조사 종료 후 백업용 (CLAUDE.md 6절)."""
    await store.flush()
    rows = await asyncio.to_thread(store.records, survey)
    if not rows:
        raise HTTPException(status_code=404, detail=f"survey {survey}: 레코드 없음")

    fmt = format.lower()
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
        # 엑셀에서 바로 열 수 있도록 BOM 을 붙인다.
        data = buf.getvalue().encode("utf-8-sig")
        return Response(
            content=data, media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="survey_{survey}.csv"'},
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
        ws.append(COLUMNS)
        for r in rows:
            ws.append([r[c] for c in COLUMNS])
        bio = io.BytesIO()
        wb.save(bio)
        return Response(
            content=bio.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="survey_{survey}.xlsx"'},
        )

    raise HTTPException(status_code=400, detail="format 은 csv 또는 xlsx")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
