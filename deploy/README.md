# 배포 가이드 (GitHub 기반)

저장소: `https://github.com/PerRight/Hi-Flow-DashBoard`

두 대에 같은 저장소를 clone 하고, **각자 다른 서비스만 켠다.**

| | 클라우드 (NCP) | 라즈베리파이 (보트) |
|---|---|---|
| 역할 | 미러 · 원격 열람 | **정본** · 측정·저장 |
| 켜는 서비스 | `uwd-server` (미러 모드) | `uwd-server` + `uwd-feed` |
| 대시보드 | nginx 로 서빙 (원격) | 핫스팟으로 서빙 (보트 위) |
| 인터넷 없으면 | 원격 열람만 중단 | **아무 영향 없음 — 측정 계속** |

> ⚠️ 두 대 모두 `UWD_MOCK=0` 이다. 목업이 켜진 채 현장에 나가면 feed 가 죽는 순간
> 가짜 값이 `status:"ok"` 로 표시된다 — CLAUDE.md 6절이 정의한 최악의 버그.

---

## A. 클라우드 서버 배포

### A-1. 코드 받기

```bash
ssh hiflow@101.79.22.64
cd ~
rm -rf server              # scp 로 올렸던 옛 복사본 제거
git clone https://github.com/PerRight/Hi-Flow-DashBoard.git app
cd app
```

Private 저장소라 GitHub 아이디와 **토큰**을 물어봅니다. 비밀번호가 아니라 토큰이에요 —
GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens 에서
이 저장소에 `Contents: Read-only` 권한만 준 토큰을 만들어 쓰세요.

### A-2. 스왑 만들기 (필수)

micro 서버는 메모리가 작아서 `npm install` 도중 그냥 죽습니다. 먼저 스왑을 잡으세요.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                    # Swap 줄에 2.0Gi 가 보이면 성공
```

### A-3. 파이썬 환경

```bash
cd ~/app/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
mkdir -p data
```

### A-4. 대시보드 빌드

```bash
sudo apt install -y nodejs npm
cd ~/app/dashboard
npm install
npm run build              # dist/ 생성 (몇 분 걸립니다)
```

`dist/` 는 `.gitignore` 대상이라 서버에서 직접 빌드합니다. 코드를 고칠 때마다
`git pull && npm run build` 를 다시 돌려야 화면에 반영됩니다.

### A-5. 서비스 등록

```bash
sudo cp ~/app/deploy/cloud/uwd-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uwd-server
systemctl status uwd-server        # active (running) 확인
```

### A-6. nginx

```bash
sudo cp ~/app/deploy/cloud/nginx-uwd.conf /etc/nginx/sites-available/uwd
sudo ln -sf /etc/nginx/sites-available/uwd /etc/nginx/sites-enabled/uwd
sudo rm -f /etc/nginx/sites-enabled/default    # IPv6 오류 내던 기본 사이트
sudo nginx -t                                   # syntax is ok 확인
sudo systemctl reload nginx
```

이제 `http://101.79.22.64.sslip.io` 로 대시보드가 떠야 합니다.

### A-7. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 101.79.22.64.sslip.io
```

certbot 이 443 블록과 인증서를 자동으로 넣어 줍니다. 이후 `https://101.79.22.64.sslip.io`.

**ACG 확인**: 80, 443 인바운드가 `0.0.0.0/0` 으로 열려 있어야 합니다.
반대로 **8000 번은 이제 닫으세요** — nginx 뒤로 숨겼으므로 직접 열어둘 이유가 없습니다.

---

## B. 라즈베리파이 설정

### B-1. 시리얼 포트 권한 (이거 빼먹으면 센서를 못 읽습니다)

```bash
sudo usermod -aG dialout pi
```

**로그아웃했다 다시 로그인해야 적용됩니다.** 확인:

```bash
groups                     # dialout 이 목록에 있어야 함
ls -l /dev/ttyUSB0         # crw-rw---- 1 root dialout ... 이어야 함
```

### B-2. ModemManager 제거 (RS485 의 고전적 함정)

ModemManager 는 USB 시리얼 장치가 꽂히면 "모뎀인가?" 하고 자동으로 붙잡습니다.
그동안 `feed.py` 는 포트를 못 열거나 값이 깨져서 읽힙니다.

```bash
sudo systemctl disable --now ModemManager
sudo apt purge -y modemmanager
```

### B-3. 코드 받기 + 파이썬 환경

```bash
cd ~
git clone https://github.com/PerRight/Hi-Flow-DashBoard.git app
cd ~/app/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -r ../raspi/requirements.txt   # 같은 venv 하나로 쓴다
mkdir -p data
```

### B-4. 센서 단독 확인 (서비스 등록 전에 반드시)

```bash
cd ~/app/raspi
../server/.venv/bin/python feed.py --once
```

EC·TDS·수온 값이 그럴듯하게 나오는지 봅니다. 값이 이상하면:

```bash
../server/.venv/bin/python feed.py --probe    # 레지스터 원시 덤프
```

> 이 단계가 CLAUDE.md 5절 3단계의 미완료 항목입니다. **여기가 통과돼야 서비스 등록으로 넘어갑니다.**

### B-5. 서비스 등록

```bash
sudo cp ~/app/deploy/raspi/uwd-server.service /etc/systemd/system/
sudo cp ~/app/deploy/raspi/uwd-feed.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uwd-server
sudo systemctl enable --now uwd-feed
```

확인:

```bash
curl localhost:8000/health
```

`"source": "esp32"` 여야 정상입니다.
`"mock"` = 목업이 켜져 있음(유닛 확인), `"none"` = feed 가 안 붙음(`journalctl -u uwd-feed -n 50`).

### B-6. 포트 이름 고정 (USB 를 여러 개 쓸 때만)

`/dev/ttyUSB0` 은 꽂는 순서에 따라 `ttyUSB1` 로 바뀔 수 있습니다.
GPS 모듈까지 USB 로 붙이면 실제로 문제가 됩니다.

```bash
udevadm info -a -n /dev/ttyUSB0 | grep -E "idVendor|idSerial" | head -4
```

나온 값으로 `/etc/udev/rules.d/99-uwd.rules`:

```
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idSerial}=="XXXX", SYMLINK+="uwd-sensor"
```

그러면 `--port /dev/uwd-sensor` 로 고정할 수 있습니다.

---

## C. 코드 갱신 (앞으로의 일상)

```bash
cd ~/app
git pull
sudo systemctl restart uwd-server      # 파이썬 코드를 고쳤으면
cd dashboard && npm run build          # 대시보드를 고쳤으면 (클라우드만)
```

---

## D. 문제 확인

```bash
systemctl status uwd-server
journalctl -u uwd-server -n 50 --no-pager
journalctl -u uwd-feed -f              # 실시간 추적 (Ctrl+C 로 종료)
curl localhost:8000/health
```

| 증상 | 원인 | 조치 |
|---|---|---|
| `source: "none"` | feed 가 안 붙음 | `journalctl -u uwd-feed` |
| `source: "mock"` | 목업이 켜짐 | 유닛에서 `UWD_MOCK=1` 제거 (6절 위반) |
| feed: Permission denied | dialout 그룹 미적용 | B-1 후 재로그인 |
| feed: 값이 깨짐 | ModemManager 간섭 | B-2 |
| nginx 기동 실패 | IPv6 `listen [::]` | 기본 사이트 제거 (A-6) |
| WebSocket 연결 실패 | `ws://` on HTTPS | `config.js` 프로토콜 자동 전환 필요 |
