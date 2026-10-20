# 로컬 개발 서버 실행

아래 [수동 실행](#수동-실행)의 두 명령을 **PowerShell 창 두 개**에서 하나씩 실행합니다 — 공개 프로세스와 내부 프로세스입니다.
종료할 때는 각 창에서 `Ctrl+C` 를 누릅니다.

| 프로세스 | 진입점 | 기본 주소 | 서빙하는 것 |
|---|---|---|---|
| 공개 | `serve_public.py` | `http://127.0.0.1:8080` | `/privacy`, `/privacy/en`, `/ebay/deletion`(GET+POST), `/ebay/auth/accepted`, `/ebay/auth/declined` |
| 내부 | `serve_internal.py` | `http://127.0.0.1:8001` | `/login`, `/`, `/staff`, `/keys`, `/logs`, `/licenses`, `/usage`, `/api/*`, 프록시 릴레이, `/updates`, `/deletions` |

- 관리자 로그인: `http://127.0.0.1:8001/login`
- eBay 삭제 알림 큐 승인: `http://127.0.0.1:8001/deletions`
- 개인정보처리방침: `http://127.0.0.1:8080/privacy`
- 시작 성공 표시: 각 창에 `Application startup complete.` 와 `Uvicorn running on ...`
- 프록시 상태 경로: `/proxy/health`(내부). 직원 토큰 없이 요청했을 때 `401`이면 경로는 정상입니다.

> **`uvicorn app:app` 은 더 이상 진입점이 아닙니다.** `app.py` 는 `serve_internal.py` 가 import 하는
> 모듈이고, 직접 띄우면 기동 자가 점검(비밀값·바인드 주소·신뢰 프록시 검사)을 통째로 건너뜁니다.
> 공개 라우트(`/privacy`, `/ebay/deletion`)는 `app.py` 에 아예 없으므로 404 가 납니다.
> 운영 배포 절차와 systemd 유닛 구성은 `배포_분리_가이드.md` 를 보세요.

## 왜 프로세스를 둘로 나눴나

인터넷에서 도달 가능한 표면에 로그인·세션·인증키 금고·프록시 릴레이가 함께 얹혀 있었습니다.
분리의 요점은 그 결함을 하나씩 고치는 것이 아니라 **인터넷에서 도달할 수 없게 만드는 것**입니다.
공개 프로세스는 `admin.db` 도, `KEY_MASTER` 도, `ADMIN_SECRET` 도 가지지 않습니다.
두 프로세스의 연결은 **내부 → 공개 큐 파일 읽기 한 방향**뿐이고, 공개 → 내부 인바운드 구멍은 없습니다.

## 필요한 환경변수

개발용 기본값은 아래 [수동 실행](#수동-실행) 명령에 들어 있습니다. 값을 바꿀 때 알아야 할 것만 적습니다.
(운영 값은 `배포_분리_가이드.md` 의 표를 따르고, 수동 실행의 값은 전부 개발용 자리표시자입니다 — 서버로 복사하지 마세요.)

### 두 프로세스 공통

| 변수 | 없으면 | 개발 기본값 |
|---|---|---|
| `VERYUP_ENV` | 내부 프로세스가 기동 거부 | `development` (파일 폴백 허용) |
| `COMPANY_NAME` / `CONTACT_EMAIL` / `DATA_RETENTION` | **`public.py` import 자체가 실패** | 자리표시자 |
| `SESSION_HTTPS_ONLY` | 운영 모드 기본 `1` | `0` — 평문 http 로는 Secure 쿠키가 왕복하지 않아 로그인·CSRF 폼이 전부 실패한다 |

`COMPANY_NAME` 3종은 값이 비면 **라우트가 503 을 내는 게 아니라 서버가 아예 뜨지 않습니다.**
플레이스홀더가 박힌 `/privacy` 는 eBay 심사에서 즉시 반려되므로 배포 즉시 드러나게 만든 것입니다.

### 공개 프로세스 전용

| 변수 | 설명 |
|---|---|
| `EBAY_DELETION_ENDPOINT` | **필수.** 없으면 `ebay_notify` import 가 실패한다. 라우트 경로와 challenge 해시 입력이 **이 문자열 하나**에서 나오므로 eBay 포털 등록값과 완전히 같아야 한다. 경로는 `/ebay/<이름>` 형태만 허용 |
| `EBAY_VERIFICATION_TOKEN` | 없으면 GET 검증이 503. 32~80자 영숫자/`_`/`-` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | 서명 검증용. 없으면 **모든** 삭제 알림이 거절 기록만 남는다(`.bat` 는 넣지 않는다 — 실제 값은 배포 환경변수로) |
| `EBAY_QUEUE_DIR` | 큐·영수증·격리 파일 전용 디렉터리. **`admin.db` 옆에 두면 안 된다** — 그 디렉터리 쓰기 권한이 곧 `admin.db` 삭제·교체 권한이다 |
| `PUBLIC_STRICT` | 자가 점검 모드. **기본값은 켜짐(기동 거부)**. 이 소스 트리는 `admin.db` 가 코드 옆에 있어 점검에 걸리므로 개발에서만 `0` |

공개 프로세스에 **있으면 안 되는** 값: `KEY_MASTER`, `ADMIN_SECRET`, `BOOTSTRAP_ADMIN_USER/PW`,
`UPDATE_TOKEN`, `STAFF_PLATFORMS`. 하나라도 있으면 기동을 거부합니다(개발에서는 경고).
그래서 `.bat` 는 공개 창을 먼저 띄운 **뒤에** `UPDATE_TOKEN` 을 설정합니다 — `start` 는 그 시점의
환경을 복사하므로 공개 창에는 그 값이 들어가지 않습니다.

### 내부 프로세스 전용

| 변수 | 설명 |
|---|---|
| `ADMIN_SECRET` | 세션·API 토큰 **서명** 전용. 최소 32자, `KEY_MASTER` 와 **다른 난수**여야 한다(같으면 기동 거부, 모드 무관) |
| `KEY_MASTER` | 인증키 Fernet **암호화** 전용. 기존 데이터를 계속 읽으려면 `server/secret.key` 내용을 그대로 넣는다. 새로 만들면 기존 암호문은 영구 복호화 불가 |
| `VERYUP_ALLOW_DEV_SECRETS` | 위 둘이 없을 때 파일 폴백(`secret.key`, `dev_admin_secret.key`)을 허용한다. **명시하지 않으면 기동 거부** — "떴으니 됐다"가 자동 생성된 키를 가려 주지 않게 한 장치다. 수동 실행 명령이 로컬 전용으로 `1` 을 넣는다 |
| `UPDATE_TOKEN` | 없으면 `/updates` 라우트가 **등록조차 되지 않는다**(= 404). 서버 값과 Electron 클라이언트의 같은 이름 환경변수를 반드시 함께 맞춘다 |
| `INTERNAL_HOST` / `INTERNAL_PORT` | 기본 `127.0.0.1:8001`. 운영은 WireGuard IP. `0.0.0.0` 은 기동 거부 |
| `STAFF_PLATFORMS` | `role='staff'` 가 `/api/credentials` 로 꺼낼 수 있는 플랫폼. 기본값은 **빈 집합** |

새 난수 만들기: `python -c "import secrets; print(secrets.token_urlsafe(32))"`

## 새 PC에서 최초 준비

Python 3.10 이상을 설치한 뒤 `server` 폴더에서 실행합니다.

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

이미 만든 `.venv`를 다른 PC로 복사하지 말고 해당 PC에서 다시 생성합니다.
`python` 명령이 Microsoft Store를 열거나 실행되지 않는 경우 실제 Python 설치 경로를 사용하세요.

## 수동 실행

아래 환경변수를 먼저 넣어야 합니다. 빠뜨리면 **import 단계에서** 죽습니다.

```powershell
# server 폴더에서 — 공개 프로세스
$env:VERYUP_ENV = 'development'
$env:COMPANY_NAME = 'VERY UP (development)'
$env:CONTACT_EMAIL = 'dev@example.test'
$env:DATA_RETENTION = '1 year (development)'
$env:EBAY_DELETION_ENDPOINT = 'http://127.0.0.1:8080/ebay/deletion'
$env:EBAY_VERIFICATION_TOKEN = 'development-only-verification-token-0000'
$env:EBAY_QUEUE_DIR = '.\ebay-queue-dev'   # data/ 에 두면 설치본에 실린다
$env:PUBLIC_STRICT = '0'      # 이 트리에서는 admin.db 가 코드 옆에 있어 기본값이면 기동 거부
.\.venv\Scripts\python.exe serve_public.py
```

```powershell
# server 폴더에서 — 내부 프로세스 (위 3개 방침 변수 + 아래)
$env:VERYUP_ALLOW_DEV_SECRETS = '1'
$env:SESSION_HTTPS_ONLY = '0'
$env:UPDATE_TOKEN = 'dev-update-token'
$env:EBAY_QUEUE_DIR = '.\ebay-queue-dev'   # 공개 프로세스가 쌓은 큐를 읽는다
.\.venv\Scripts\python.exe serve_internal.py
```

`--app-dir` 로 루트에서 띄우려면 모듈 이름을 진입점으로 바꿉니다.

```powershell
.\server\.venv\Scripts\python.exe -m uvicorn serve_internal:app --app-dir .\server --host 127.0.0.1 --port 8001
.\server\.venv\Scripts\python.exe -m uvicorn serve_public:app   --app-dir .\server --host 127.0.0.1 --port 8080
```

## 테스트

파이썬 테스트는 `server/.venv` 의 파이썬으로 돌립니다(`tests/server_env.py` 가 필요한 환경변수를
import 전에 깔아 주므로 별도 설정이 필요 없습니다. 실제 `admin.db`·`secret.key` 는 건드리지 않습니다).

```powershell
# 프로젝트 루트에서
.\server\.venv\Scripts\python.exe -m pip install pytest
.\server\.venv\Scripts\python.exe -m pytest tests -q
```

`python -m unittest discover -s tests -p test_*.py` 로도 같은 테스트가 돕니다.

## 오류 구분

| 메시지/증상 | 확인할 내용 |
|---|---|
| `개인정보처리방침 환경변수가 비어 있습니다` | `COMPANY_NAME` / `CONTACT_EMAIL` / `DATA_RETENTION` 을 넣습니다. 라우트가 아니라 **import** 에서 막습니다 |
| `EBAY_DELETION_ENDPOINT 환경변수가 필요합니다` | 공개 프로세스에 그 값을 넣습니다. 기본값을 두지 않는 이유는 로컬 서버가 운영 주소 행세를 하지 못하게 하기 위함입니다 |
| `내부 프로세스 기동 거부 — 환경변수 ADMIN_SECRET, KEY_MASTER 가 없습니다` | 로컬이면 `VERYUP_ALLOW_DEV_SECRETS=1`, 운영이면 두 값을 주입합니다 |
| `ADMIN_SECRET 이 너무 짧다` / `암호화 키와 같은 값이다` | 32자 이상의 **서로 다른** 난수를 씁니다. 개발 모드에서도 적용됩니다 |
| `공개 프로세스가 admin.db 를 읽을 수 있습니다` | 이 소스 트리에서는 정상입니다. 개발은 `PUBLIC_STRICT=0`, 운영은 별도 OS 계정으로 띄웁니다 |
| `Could not import module "app"` | `app:app` 은 진입점이 아닙니다. `serve_internal:app` 을 쓰세요 |
| `No module named uvicorn` 등 | 위 `.venv`의 Python으로 `requirements.txt`를 설치합니다 |
| 주소 사용 중 / `WinError 10048` | 8001 또는 8080 포트에 이미 서버가 떠 있습니다. 중복 실행을 확인합니다 |
| 로그인 후 바로 로그아웃 / 폼이 403 | `SESSION_HTTPS_ONLY=0` 인지 확인합니다. 평문 http 에서는 Secure 쿠키가 돌아오지 않습니다 |
| `/privacy` 가 8001 에서 404 | 정상입니다. 공개 라우트는 8080(공개 프로세스)에만 있습니다 |
| `/updates` 가 404 | `UPDATE_TOKEN` 이 없으면 라우트를 등록하지 않습니다. 401 이면 토큰 값이 틀린 것입니다 |

## 앱을 로컬 서버에 붙이기

로컬 서버 실행은 `admin.veryup-domain.duckdns.org` 운영 서버 배포와 별개입니다.
앱이 로컬 서버에 로그인해야 하면 같은 PowerShell 창에서 실행합니다.
로컬 서버 계정과 저장된 인증키는 운영 서버와 다를 수 있습니다.

```powershell
# 프로젝트 루트에서 실행
$env:ADMIN_SERVER_URL = 'http://127.0.0.1:8001'
npm start
```

`server/admin.db`와 `server/secret.key`는 기존 계정·인증키 데이터이므로
실행 오류 해결을 위해 삭제하거나 교체하지 마세요.
