"""
forward.py — 라즈베리파이(정본) → NCP 클라우드(미러) 중계기.

CLAUDE.md 0절의 `forwarder → LTE → NCP 클라우드 서버 (미러)` 다.

동작
    ① 라즈베리파이 서버의 /ws/dashboard 를 **대시보드처럼 구독**한다.
       live 와 측정 레코드가 이미 그 채널로 나오므로 engine 을 고칠 필요가 없다.
    ② 받은 것을 클라우드 /ws/mirror 로 그대로 넘긴다. 판정·재계산은 하지 않는다.
    ③ 클라우드에 (재)접속할 때마다 클라우드가 알려 준 max_ts 보다 새 레코드를
       라즈베리파이 REST(/surveys·/records)에서 읽어 **백필**한다.

설계 근거 (CLAUDE.md 0절)
    - **LTE 끊김은 정상 시나리오다.** 끊긴 동안 측정은 라즈베리파이 SQLite 에
      계속 쌓이고, 이 프로그램이 죽어 있어도 측정에는 아무 영향이 없다.
      그래서 여기서는 재시도만 하고, 실패를 위로 전파하지 않는다.
    - **live 는 백필하지 않는다.** live 는 저장 대상이 아니라서(1절) 되돌릴 원본이
      없다. 끊긴 구간은 원격 화면에서 공백으로 남는 것이 맞다 — 없는 값을
      메워 넣으면 6절이 금지한 "오래된 데이터를 정상처럼" 이 된다.
    - **명령은 클라우드에서 되돌아온다** (사용자 확정 2026-09-13). 조작자가 보트 위에서
      클라우드 화면을 쓰기 때문에 원격 조작을 허용한다. 다만 **상태기계는 Pi 에 그대로**
      있고, 이 프로그램은 버튼 누름을 Pi 의 /ws/dashboard 로 넘기기만 한다.
      클라우드가 수심을 적분하면 보트와 클라우드가 서로 다른 수심을 말하게 된다.
    - 클라우드 연결이 끊기면 **명령이 갈 길도 끊긴다.** 미러가 이 사실을 알고
      대시보드 버튼을 잠그므로, 여기서 큐에 쌓아 두었다가 나중에 실행하지 않는다 —
      몇 분 전 '내림'이 뒤늦게 실행되면 실제 윈치와 어긋난다.

사용법
    UWD_MIRROR_TOKEN=... python3 forward.py --cloud wss://<호스트>/ws/mirror

    --local   라즈베리파이 서버 (기본 ws://localhost:8000)
    --dry-run 클라우드에 붙지 않고 무엇을 보낼지만 출력
"""

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request

DEFAULT_LOCAL = "ws://localhost:8000"
BACKOFF_START = 0.5
BACKOFF_MAX = 10.0          # CLAUDE.md 4절 — 지수 백오프 상한 10초
BACKFILL_CHUNK = 200        # 한 메시지에 담을 레코드 수 (nginx client_max_body_size 1m)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _http_json(base, path):
    """라즈베리파이 REST 호출. 동기 함수라 반드시 to_thread 로 부른다."""
    with urllib.request.urlopen(f"{base}{path}", timeout=10) as r:
        return json.loads(r.read())


class Forwarder:
    def __init__(self, local_ws, local_http, cloud, token, dry_run=False):
        self.local_ws = local_ws
        self.local_http = local_http
        self.cloud = cloud
        self.token = token
        self.dry_run = dry_run

        # 클라우드로 나갈 큐. 가득 차면 **오래된 것부터 버린다** — LTE 가 막혔을 때
        # 메모리를 무한정 먹지 않게. 버려진 측정 레코드는 다음 접속 때 백필로 되살아나고,
        # live 는 원래 백필 대상이 아니다.
        self.out = asyncio.Queue(maxsize=600)
        self.sent = 0
        self.dropped = 0
        self.last_survey = None
        # 주의: local_ws 는 **URL 문자열**이다. 명령을 되돌려 보낼 소켓은 별도 이름으로 둔다.
        self.local_sock = None
        self.relayed_cmds = 0

    # ── 라즈베리파이 구독 ─────────────────────────────────────────────────
    async def watch_local(self):
        import websockets
        backoff = BACKOFF_START
        while True:
            try:
                url = f"{self.local_ws}/ws/dashboard"
                async with websockets.connect(url, open_timeout=5, ping_interval=20) as ws:
                    log(f"라즈베리파이 구독 시작 {url}")
                    self.local_sock = ws        # 명령을 여기로 되돌려 보낸다
                    backoff = BACKOFF_START
                    try:
                        while True:
                            msg = json.loads(await ws.recv())
                            await self.on_local(msg)
                    finally:
                        self.local_sock = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log(f"라즈베리파이 연결 실패: {type(exc).__name__}: {exc} "
                    f"→ {backoff:.1f}초 후 재시도")
                await asyncio.sleep(backoff)
                backoff = min(BACKOFF_MAX, backoff * 2)

    async def on_local(self, msg):
        if msg.get("type") == "live":
            # 차수가 새로 열리면 그 행을 먼저 보내야 레코드의 survey 참조가 산다.
            sid = msg.get("survey")
            if sid is not None and sid != self.last_survey:
                self.last_survey = sid
                await self.push({"type": "survey", "row": await self.survey_row(sid)})
            await self.push(msg)
        elif msg.get("type") == "ack":
            # Pi 의 진짜 판정 결과 — 클라우드로 되돌려 대시보드에 알린다.
            await self.push({"type": "ack", "ack": msg})
        elif "depth" in msg and "survey" in msg:
            await self.push({"type": "record", "rec": msg})   # 측정 레코드

    async def on_cloud_cmd(self, cmd):
        """클라우드 대시보드가 누른 버튼을 Pi 로 넘긴다 (사용자 확정 2026-09-13).

        여기서 해석하거나 판단하지 않는다 — 명령의 유효성도 실행도 전부 Pi 몫이고,
        결과(ack)는 on_local 이 클라우드로 되돌려 보낸다.
        Pi 소켓이 끊겨 있으면 **버린다**. 나중에 실행하면 조작자가 이미 손을 뗀
        뒤에 윈치 모델만 움직여 실제와 어긋난다 (CLAUDE.md 6절).
        """
        sock = self.local_sock
        if sock is None:
            log(f"명령 버림 — 라즈베리파이 연결 끊김: {cmd.get('cmd')}")
            await self.push({"type": "ack", "ack": {
                "type": "ack", "cmd": cmd.get("cmd"), "ok": False, "reason": "local_down"}})
            return
        try:
            await sock.send(json.dumps(cmd, allow_nan=False))
            self.relayed_cmds += 1
            log(f"명령 중계 → Pi: {cmd.get('cmd')}")
        except Exception as exc:
            log(f"명령 중계 실패: {exc}")

    async def survey_row(self, sid):
        """차수 행 한 건. /surveys 는 id 를 `survey` 키로 준다 — 미러 스키마에 맞춰 되돌린다."""
        try:
            info = await asyncio.to_thread(_http_json, self.local_http, "/surveys")
            for r in info.get("surveys", []):
                if r.get("survey") == sid:
                    return {"id": sid, "site": r.get("site"),
                            "survey_date": r.get("survey_date"), "round": r.get("round"),
                            "memo": r.get("memo"), "started_at": r.get("started_at"),
                            "ended_at": r.get("ended_at")}
        except Exception as exc:
            log(f"차수 조회 실패(무시): {exc}")
        return {"id": sid}

    async def push(self, msg):
        if self.out.full():
            try:
                self.out.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
        try:
            self.out.put_nowait(msg)
        except asyncio.QueueFull:
            self.dropped += 1

    # ── 클라우드 송신 ─────────────────────────────────────────────────────
    async def send_cloud(self):
        import websockets
        backoff = BACKOFF_START
        while True:
            try:
                log(f"클라우드 연결 시도 {self.cloud}")
                async with websockets.connect(self.cloud, open_timeout=10,
                                              ping_interval=20) as ws:
                    await ws.send(json.dumps({"type": "hello", "token": self.token}))
                    ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    if ready.get("type") != "ready":
                        raise RuntimeError(f"핸드셰이크 실패: {ready}")
                    max_ts = int(ready.get("max_ts") or 0)
                    log(f"클라우드 연결됨 — 미러의 max_ts={max_ts}")
                    backoff = BACKOFF_START

                    await self.backfill(ws, max_ts)

                    # 송신(Pi→클라우드)과 수신(클라우드→Pi 명령)을 같이 돌린다.
                    # 둘 중 하나가 죽으면 연결을 새로 맺는다.
                    async def pump_out():
                        while True:
                            msg = await self.out.get()
                            await ws.send(json.dumps(msg, allow_nan=False))
                            self.sent += 1

                    async def pump_in():
                        while True:
                            msg = json.loads(await ws.recv())
                            if msg.get("type") == "cmd":
                                await self.on_cloud_cmd(msg.get("msg") or {})

                    done, rest = await asyncio.wait(
                        [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())],
                        return_when=asyncio.FIRST_EXCEPTION)
                    for t in rest:
                        t.cancel()
                    for t in done:
                        t.result()          # 예외를 밖으로 올려 재연결시킨다
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # LTE 끊김은 정상 시나리오다 — 조용히 재시도한다.
                log(f"클라우드 끊김: {type(exc).__name__}: {exc} → {backoff:.1f}초 후 재연결")
                await asyncio.sleep(backoff)
                backoff = min(BACKOFF_MAX, backoff * 2)

    async def backfill(self, ws, max_ts):
        """미러가 못 받은 구간을 라즈베리파이 SQLite 에서 읽어 보낸다."""
        try:
            info = await asyncio.to_thread(_http_json, self.local_http, "/surveys")
        except Exception as exc:
            log(f"백필 건너뜀 — 차수 조회 실패: {exc}")
            return

        rows = info.get("surveys", [])
        pending = []
        for r in rows:
            sid = r.get("survey")
            # 차수 행은 항상 먼저 보낸다(레코드가 참조한다). 중복은 미러가 흡수한다.
            await ws.send(json.dumps({"type": "survey", "row": {
                "id": sid, "site": r.get("site"), "survey_date": r.get("survey_date"),
                "round": r.get("round"), "memo": r.get("memo"),
                "started_at": r.get("started_at"), "ended_at": r.get("ended_at")}}))
            # 그 차수의 마지막 레코드가 미러보다 오래됐으면 볼 것도 없다.
            if (r.get("end_ts") or 0) <= max_ts:
                continue
            try:
                got = await asyncio.to_thread(
                    _http_json, self.local_http, f"/records?survey={sid}")
            except Exception as exc:
                log(f"차수 {sid} 레코드 조회 실패(건너뜀): {exc}")
                continue
            pending += [x for x in got.get("records", []) if (x.get("ts") or 0) > max_ts]

        if not pending:
            log("백필할 레코드 없음 — 미러가 최신이다")
            return

        pending.sort(key=lambda x: x.get("ts") or 0)
        log(f"백필 {len(pending)}건 전송 시작 (ts > {max_ts})")
        for i in range(0, len(pending), BACKFILL_CHUNK):
            chunk = pending[i:i + BACKFILL_CHUNK]
            await ws.send(json.dumps({"type": "backfill", "records": chunk},
                                     allow_nan=False))
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            log(f"  {i + len(chunk)}/{len(pending)} — 미러 저장 {ack.get('stored')}건")
        log("백필 완료")

    # ── 상태 출력 ─────────────────────────────────────────────────────────
    async def report(self, every=60):
        while True:
            await asyncio.sleep(every)
            log(f"중계 {self.sent}건 · 대기 {self.out.qsize()} · 버림 {self.dropped} "
                f"· 명령 {self.relayed_cmds}건")

    async def run(self):
        if self.dry_run:
            await asyncio.gather(self.watch_local(), self.drain_dry())
            return
        await asyncio.gather(self.watch_local(), self.send_cloud(), self.report())

    async def drain_dry(self):
        while True:
            msg = await self.out.get()
            kind = msg.get("type")
            if kind == "live":
                log(f"[dry] live state={msg.get('state')} gps={msg.get('gps')} "
                    f"lat={msg.get('lat')}")
            else:
                log(f"[dry] {kind} {json.dumps(msg, ensure_ascii=False)[:140]}")


def main(argv=None):
    p = argparse.ArgumentParser(
        description="라즈베리파이 → 클라우드 미러 중계기 (CLAUDE.md 0절 forwarder)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--local", default=DEFAULT_LOCAL,
                   help="라즈베리파이 서버 (ws:// 또는 http://, 포트 포함)")
    p.add_argument("--cloud", default=os.environ.get("UWD_MIRROR_URL", ""),
                   help="클라우드 미러 WebSocket (예: wss://호스트/ws/mirror)")
    p.add_argument("--token", default=os.environ.get("UWD_MIRROR_TOKEN", ""),
                   help="공유 토큰 (환경변수 UWD_MIRROR_TOKEN 권장 — 명령줄은 ps 에 보인다)")
    p.add_argument("--dry-run", action="store_true",
                   help="클라우드에 붙지 않고 무엇을 보낼지만 출력")
    args = p.parse_args(argv)

    local = args.local.rstrip("/")
    local_ws = local.replace("https://", "wss://").replace("http://", "ws://")
    local_http = local.replace("wss://", "https://").replace("ws://", "http://")

    if not args.dry_run:
        if not args.cloud:
            log("--cloud 가 필요합니다 (또는 UWD_MIRROR_URL).")
            return 2
        if not args.token:
            log("토큰이 없습니다 — UWD_MIRROR_TOKEN 을 설정하세요. "
                "인증 없이 미러에 붙지 않습니다.")
            return 2
        if args.cloud.startswith("ws://") and "localhost" not in args.cloud:
            log("경고: 평문 ws:// 입니다. 토큰이 그대로 노출됩니다 — wss:// 를 쓰세요.")

    fwd = Forwarder(local_ws, local_http, args.cloud, args.token, args.dry_run)
    try:
        asyncio.run(fwd.run())
    except KeyboardInterrupt:
        log("중단됨")
    return 0


if __name__ == "__main__":
    sys.exit(main())
