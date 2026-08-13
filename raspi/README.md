# raspi — EC/TDS 일체형 센서 직결 수집기

라즈베리파이가 RS485 로 **EC/TDS 일체형 센서를 직접 읽어** 서버(`server/app.py`)의
`/ws/ingest` 에 1 Hz 로 밀어 넣는다. 보트에서 유선 케이블로 프로브를 직접 내리는
구성이며(ESP32 계층 없음), 서버·대시보드는 들어오는 스키마만 알면 된다.

```
EC/TDS 센서 ──RS485(A/B)── USB-RS485 어댑터 ── 라즈베리파이 ── feed.py ──ws──▶ /ws/ingest
                                                                (서버는 같은 파이여도 됨)
```

보내는 것은 CLAUDE.md 1절 원시 스키마뿐이다. 키 추가·개명 금지.

```json
{"seq": 1024, "ec": 187.5, "tds": 93.0, "temp": 21.3}
```

`tds`(ppm)는 **센서가 계산해 주는 값을 그대로** 전달한다(EC×팩터 재계산 금지 — 1·4절).
pH 는 센서 구성에서 제외됐다(사용자 확정, 2026-08-10).

## 센서 사양 (CLAUDE.md 4절 — 실장착 개체의 동작 확인된 값)

| 항목 | 값 |
|---|---|
| 포트 | `/dev/ttyUSB0` (USB-RS485 어댑터) |
| 프로토콜 | Modbus-RTU, **주소 5**, 9600-8N1, timeout **1.0 s** |
| 읽기 | **FC03**(홀딩 레지스터), 값은 전부 **uint16 정수** |
| reg0 | 수온 — 원시값 **×0.1 ℃** (213 → 21.3 ℃) |
| reg1 | EC — µS/cm (스케일 없음) |
| reg4 | TDS — ppm (스케일 없음) |

검증된 통신 관행 — **임의로 "개선"하지 말 것**:

- `clear_buffers_before_each_transaction = True`
- `close_port_after_each_call = True` (호출마다 포트를 닫는다)
- 레지스터 읽기 사이 `time.sleep(0.05)`
- reg0 / reg1 / reg4 를 **개별 `read_register` 3회**로 읽는다 (블록 읽기로 바꾸지 않는다)

> DEC890 매뉴얼(주소 17 / FC04 / float byte-swap)과는 전혀 다르다.
> 실장착 개체 기준이 정답이고, DEC890 자료는 레거시/참고용이다(아래 8절).

## 파일

| 파일 | 역할 |
|---|---|
| `ects.py` | **실장착 센서 리더.** FC03 개별 읽기 3회, 스케일 변환은 순수 함수로 분리. 실패 시 `None` |
| `feed.py` | CLI. 1 Hz 폴링 + WebSocket 송신 + 현장 디버그 모드(`--probe` / `--once`) |
| `dec890.py` | **레거시/참고용.** 구형 DEC890(FC04·float) 리더. `--driver dec890` 으로만 쓰인다 |
| `requirements.txt` | `minimalmodbus`, `websockets` |

## 1. 배선

### 공통 (전원 — 여기서 태워 먹는 사고가 제일 많다)

- 센서 전원 사양은 개체 라벨/벤더 문서를 따른다. 라즈베리파이 5 V·3.3 V 핀으로
  구동하지 말 것(12 V 어댑터 또는 보트 배터리 권장).
- **접지 공통**: 센서 전원의 GND 와 라즈베리파이(또는 RS485 어댑터) GND 를 반드시
  연결한다. 이걸 빠뜨리면 "가끔 되다가 CRC 오류"가 난다.
- A/B 는 트위스트 페어로. 케이블이 길면(>10 m) 양 끝 120 Ω 종단저항.

### (A) USB-RS485 어댑터 — 권장, 가장 간단

```
센서  A ── A(또는 D+)  USB-RS485 어댑터 ── 라즈베리파이 USB
센서  B ── B(또는 D-)
센서 GND ── 어댑터 GND ── 전원 GND (공통)
센서 V+  ── DC 전원 (+)
```
포트는 보통 `/dev/ttyUSB0`.

```bash
ls -l /dev/ttyUSB*          # 꽂기 전/후 비교
dmesg | tail                # ch341 / ft232 / cp210x 인식 로그
sudo usermod -aG dialout $USER && 재로그인    # 권한 오류(Permission denied) 시
```

### (B) GPIO UART + RS485 HAT/모듈

```
HAT A/B ── 센서 A/B,  GND 공통,  센서 V+ 는 여전히 별도 전원
```
라즈베리파이 UART 는 기본적으로 **시리얼 콘솔**이 잡고 있으므로 반드시 해제한다.

```bash
sudo raspi-config
#  Interface Options → Serial Port
#     "login shell over serial?"     → No     (콘솔 끄기)
#     "serial port hardware enabled?"→ Yes
sudo reboot
```
포트는 `/dev/serial0`. 자동 방향전환(auto-direction) HAT 가 아니면 DE/RE 제어가 필요해
이 스크립트로는 동작하지 않는다 — **auto-direction 모듈을 쓸 것.**

## 2. 설치

```bash
cd ~/수중드론\ 대시보드/raspi
pip install -r requirements.txt --break-system-packages
#  (권장) 가상환경: python3 -m venv ~/venv && ~/venv/bin/pip install -r requirements.txt
```

## 3. 현장 순서

### ① 센서만 확인 — `--probe`

서버 없이 `reg0~reg9` 원시 덤프와 스케일 해석표를 한 화면에 찍는다.

```bash
python3 feed.py --port /dev/ttyUSB0 --probe
```
```
── 원시 레지스터 (FC03 홀딩, reg0~reg9, uint16) ──────────────────
  reg0   0x00D5     213
  reg1   0x00BC     188
  reg4   0x005E      94
  ...
── 스케일 해석 (CLAUDE.md 4절 레지스터 맵) ───────────────────────
  레지스터    원시값    해석                    판정
  reg0 수온   213       21.3 ℃  (원시 ÷10)      ok
  reg1 EC     188       188.0 µS/cm             ok
  reg4 TDS    94        94.0 ppm                ok
```
- 판정은 **수온을 먼저** 본다(지금 수온/기온과 비슷하면 통신·스케일이 맞는 것).
- 프로브가 공기 중이면 EC·TDS ≈ 0 이 정상이라 그 둘만으로는 못 고른다.
- reg2·3·5~9 는 이 프로젝트에서 쓰지 않는다(벤더 미공개, 참고용 덤프).

### ② 값 한 번 보기 — `--once`

```bash
python3 feed.py --port /dev/ttyUSB0 --once
```

### ③ 서버로 흘리기

**`UWD_SENSORS` 를 지정할 필요가 없다.** 이제 `ec`·`tds`·`temp` 세 값을 센서 하나가 모두
주므로 서버 기본값(`ec,tds,temp`) 그대로 띄우면 된다.

```bash
# 서버 (같은 파이에서) — 목업 없이, 기본값 그대로
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000

# 서버가 같은 파이에 있을 때
python3 feed.py --port /dev/ttyUSB0 --server ws://localhost:8000/ws/ingest

# 서버가 다른 파이/PC 일 때
python3 feed.py --port /dev/ttyUSB0 --server ws://192.168.4.1:8000/ws/ingest
```
1초마다 `seq / ec / tds / temp` 가 화면에 찍힌다(`--quiet` 로 끌 수 있음).

> **⚠ 목업이 꺼져 있는지 확인할 것 — `UWD_MOCK` 기본값은 `0`(비활성)이다.**
> 아무것도 붙이지 않고 서버를 띄우면 목업은 돌지 않는다. 다만 개발·시연용으로
> `UWD_MOCK=1` 을 붙여 놓은 셸(또는 systemd unit)을 그대로 현장에 들고 오면,
> feed 가 죽는 순간 목업이 조용히 이어받아 **가짜 값이 `status:"ok"` 로 대시보드에 뜬다.**
> CLAUDE.md 6절이 말하는 최악의 버그에 정확히 해당한다.
> ```bash
> curl localhost:8000/health
> ```
> `source` 가 `esp32`(=/ws/ingest 접속 중, 실측)여야 한다
> (`mock` = 목업이 켜져 있다, `none` = 아무것도 안 들어옴).

### 전체 옵션

| 인자 | 기본값 | 설명 |
|---|---|---|
| `--driver` | `ects` | 센서 드라이버. `ects`=실장착 EC/TDS 일체형, `dec890`=레거시(8절) |
| `--port` | `/dev/ttyUSB0` | 시리얼 포트 (GPIO UART 는 `/dev/serial0`) |
| `--server` | `ws://localhost:8000/ws/ingest` | 서버 WebSocket URL |
| `--addr` | `5` (dec890 은 `17`) | Modbus 슬레이브 주소 |
| `--baud` | `9600` | 보레이트 (8N1 고정) |
| `--interval` | `1.0` | 폴링 주기(초) |
| `--timeout` | `1.0` (dec890 은 `0.4`) | Modbus 응답 대기(초). **검증된 값이므로 그대로 둘 것** |
| `--order` | — | **`--driver dec890` 전용.** float 워드/바이트 순서 |
| `--probe` / `--once` | — | 디버그 모드 (서버 접속 안 함) |
| `--fake` | — | **시험 전용**. 센서 없이 가짜 값 송신(하드웨어 없이 서버 왕복 점검) |
| `--quiet` | — | 틱마다 값 출력 끄기 (systemd 로 돌릴 때) |

## 4. 동작 규칙 (CLAUDE.md 준수 사항)

- **읽기 실패한 틱은 아예 보내지 않는다.** 서버가 2초 뒤 `status:"stale"` 로
  바꾸고 대시보드가 "연결 끊김"을 표시한다(6절). 마지막 값을 재전송하지 않는다.
  (세 레지스터 중 일부만 실패하면 그 항목만 `null` 로 보낸다 — 값을 꾸며 내지 않는다.)
- WebSocket 끊기면 지수 백오프로 재연결(0.5 → 1 → 2 → 4 → 8 → **최대 10초**).
  재연결 후에는 밀린 표본을 재전송하지 않고 현재값부터 보낸다(6절).
- `seq` 는 **성공한 읽기에만** 증가한다. 서버 로그의 seq 구멍 = 센서 읽기 실패 구간.
- EC·TDS 를 코드에서 재보정하지 않는다(4절). `round(…, 2)` 는 표현 잡음 제거일 뿐이다.
- 교정 레지스터 정보가 없는 센서다 → 1413 µS/cm 표준액 **대조 검증**(±5%)으로 갈음한다.
  편차가 5%를 넘으면 벤더 문의 후 CLAUDE.md 4절에 기입한다.

## 5. 하드웨어 없이 왕복 점검 — `--fake`

```bash
# 터미널 1 (server/ 에서)
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000
# 터미널 2 (raspi/ 에서)
python3 feed.py --fake --server ws://localhost:8000/ws/ingest
```
`curl localhost:8000/health` 의 `source` 가 `esp32` 로 바뀌고 `live_sent` 가 올라가면 성공.

## 6. systemd 등록 (부팅 시 자동 실행)

`/etc/systemd/system/uwd-feed.service`:

```ini
[Unit]
Description=UWD EC/TDS feed (RS485 -> /ws/ingest)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/수중드론 대시보드/raspi
ExecStart=/usr/bin/python3 feed.py --port /dev/ttyUSB0 \
          --server ws://localhost:8000/ws/ingest --quiet
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now uwd-feed
journalctl -u uwd-feed -f      # 현장 로그 확인
```
> USB 어댑터를 여러 개 꽂으면 `/dev/ttyUSB0` 번호가 뒤바뀐다. 고정하려면
> `/etc/udev/rules.d/99-rs485.rules` 에
> `SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", SYMLINK+="rs485"` 같은 규칙을 넣고
> `--port /dev/rs485` 를 쓴다(`udevadm info -a -n /dev/ttyUSB0` 로 벤더 ID 확인).

## 7. 트러블슈팅 — 현장 증상 3가지

### ① 타임아웃 (`No communication with the instrument (no answer)`)

순서대로 의심한다.
1. **A/B 반전** — 가장 흔하다. 두 선을 바꿔 꽂고 다시 시도(반전은 고장 안 남).
2. **센서 전원** — 실제로 인가되는지 테스터로 확인. USB 5 V 로는 안 되는 개체가 많다.
3. **주소·보레이트** — 이 개체는 **주소 5 / 9600** 이다. 바뀌었을 수 있으니 훑어본다.
   ```bash
   for a in 1 5 17; do for b in 4800 9600 19200; do
     echo "--- addr=$a baud=$b"; python3 feed.py --addr $a --baud $b --once
   done; done
   ```
4. **포트 지정 오류/권한** — `ls -l /dev/ttyUSB*`, `dialout` 그룹, 다른 프로그램이
   포트를 쥐고 있지 않은지(`sudo fuser -v /dev/ttyUSB0`).
5. GPIO UART 라면 **시리얼 콘솔이 안 꺼져 있음**(1-(B) 참조).

### ② 값이 터무니없다

통신은 되고 있다는 뜻이라 좋은 신호다. `--probe` 로 원시값과 해석을 같이 본다.

```bash
python3 feed.py --port /dev/ttyUSB0 --probe
```
- 수온이 원시값의 1/10 로 지금 기온과 비슷한가? → 스케일 정상.
- EC 만 이상하면 프로브 오염·기포·건조 상태를 먼저 확인하고, 1413 µS/cm 표준액으로 대조.
- **코드에서 보정 계수를 넣지 말 것**(4절). 벗어나면 벤더 문의 후 CLAUDE.md 에 기록.

### ③ 간헐적 CRC 오류 / 값이 됐다 안 됐다 한다

→ 거의 항상 **접지·케이블 문제**다.
- 센서 전원 GND ↔ 라즈베리파이/어댑터 GND **공통 접지** 확인(제일 흔한 원인).
- A/B 를 트위스트 페어로, 전원선과 나란히 길게 묶어 다니지 않기.
- 긴 케이블은 양 끝 120 Ω 종단. 물에 젖은 커넥터·헐거운 단자 확인.
- 보트에서 모터/윈치가 돌 때만 깨진다면 노이즈다 — 전원 분리, 페라이트 코어.
- 실패해도 그 틱만 건너뛰므로 대시보드는 `stale` 로 정직하게 표시된다.
  로그의 `센서 읽기 실패` 빈도로 심각도를 판단한다(1분에 몇 번인지).

## 8. 레거시 — DEC890 (참고용, 실장착 센서 아님)

`dec890.py` 는 구형 DEC890(주소 17 / FC04 / float 2워드)을 붙일 때만 쓴다.
값 해석에 워드/바이트 순서 문제가 있어 `--order` 가 필요했던 경로다.

```bash
python3 feed.py --driver dec890 --probe                  # 워드 순서 판별표
python3 feed.py --driver dec890 --order little-swap --once
```

- DEC890 경로는 `ec`·`temp` 만 준다 → `tds` 는 `null` 로 송신된다.
  그 상태로 오래 쓸 거라면 서버를 `UWD_SENSORS=ec,temp` 로 띄워야 `fault` 가 안 뜬다.
- `--order` 는 이 드라이버에서만 유효하다(실장착 센서는 uint16 이라 순서 개념이 없다).
- 새 배선·새 현장에서는 쓰지 않는다. 참고 자료로만 남겨 둔 코드다.
