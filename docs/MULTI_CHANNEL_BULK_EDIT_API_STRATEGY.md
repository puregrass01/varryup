# 다채널 일괄 수정 · API 전략 (설계 참고)

> **이 문서는 설계 참고용입니다. 실제 계약은 코드입니다.**
> 엔드포인트·요청 간격·재시도 규칙이 이 문서와 코드가 다르면 코드가 맞습니다. 각 항목에 코드 위치를 적어 두었으니 그곳을 먼저 보세요.
> 2026-11-05 코드 기준으로 다시 썼습니다. 이전 판(2026-09-29)의 예시 URL·요청량 표·재시도 규칙은 코드와 맞지 않아 지웠습니다.

---

## 0. LLM 사용 원칙

LLM(Claude 등)은 **읽고, 요약하고, 초안을 쓰고, 계획을 만듭니다.** 운영 몰에 쓰는 일은 VERY UP 이나 검증된 스크립트가 **사람 확인 뒤에** 합니다.

| 할 일 | 맡는 쪽 |
| :--- | :--- |
| 가격·재고·이미지·상품명 쓰기, 환율 가격 계산 | VERY UP (결정적 코드) |
| 송장 등록, 취소·반품·교환 처리, 오늘출발·출고지 변경 | 스크립트 또는 VERY UP 새 탭 (사람 승인) |
| 정산·부가세·수수료 집계와 대사 | 스크립트 |
| 즉석 조회, CS 답변 초안, 클레임 요약, 정산 차이 설명 | LLM (읽기 전용) |
| 자연어 요청 → 변경 목록(CSV/JSON) | LLM. 적용은 VERY UP 일괄 수정 경로 |

LLM 에게 쓰기를 허용할 때의 조건:
1. **기본 읽기 전용.** 외부 MCP 를 쓰면 쓰기 도구를 이름 단위로 막습니다.
2. **계획 → 확인 → 적용.** 계획에는 대상 ID, 현재값, 새 값, 건수, 금액 합계가 들어갑니다. 본보기는 아임웹·카페24 Claude 커넥터의 `plan_*` → `apply_plan(confirm)` 입니다.
3. **멱등성.** 작업 ID + digest 를 기록하고, 쓰기 직전 현재값을 다시 읽어 비교하고, 쓰기 요청은 재시도하지 않습니다(§1.3).
4. **개인정보.** 주문자 이름·주소·전화는 가린 채 넘깁니다. 고객 문의 본문은 프롬프트 인젝션 경로이므로 쓰기 권한이 있는 세션에 넣지 않습니다.
5. **토폴로지.** 네이버·쿠팡은 호출 IP 허용 목록이 있어 클라우드에서 바로 부를 수 없고, 아임웹은 앱+사이트당 토큰이 하나뿐입니다(§2). LLM 도구는 VERY UP 어댑터를 감싸서 쓰고, 자격증명을 따로 들고 직접 부르지 않습니다.

외부 MCP 검토 결과(2026-11-05): `space-cap/mcp-coupang-server`(파트너스 API), `burlesquer/coupang-mcp`(소비자 화면 스크레이퍼)는 판매자 업무에 쓸 수 없습니다. `Hayeon27/smartstore-mcp`, `YosefHayim/ebay-mcp` v2 는 읽기 보조로만 쓸 수 있습니다(POST 5xx 재시도 → 중복 위험).

---

## 1. 공통 규칙

### 1.1 쓰기 방식 구분
부분 본문을 전체 교체 엔드포인트에 보내면 빠진 필드가 지워집니다. 몰마다 방식이 다르니 §2 를 따릅니다.

| 몰 | 가격·재고 | 상품 본문(이름·이미지·상세) |
| :--- | :--- | :--- |
| 네이버 | 원상품 GET → 전체 PUT | 원상품 GET → 전체 PUT |
| 쿠팡 | 승인 상품: `vendor-items` 가격·재고 PUT (본문 PUT 아님) | `seller-products` GET → 전체 PUT |
| eBay | `bulk_update_price_quantity` (25건 묶음) | `inventory_item` 전체 PUT |
| 아마존 | Listings PATCH | Listings PATCH (PUT 은 전체 교체라 본문에 없는 속성이 지워짐, `amazon_api.js:298`) |
| 아임웹 | `PATCH /products/{no}/price`, `option-details` | `PATCH /products/{no}` (form-data) |

### 1.2 요청 간격
여러 직원 PC 가 같은 키를 나눠 씁니다. 아래는 **PC 한 대** 기준이고, PC 간 합계는 서버 pacer 가 맡아야 합니다(쿠팡 릴레이 `server/proxy.py` `_Pacer`).

| 몰 | 한도 | 코드 |
| :--- | :--- | :--- |
| 네이버 | API별 2 RPS, 넘으면 처리 없이 429 | `utils/rate_limiter.js` `CALL_GAP_MS.naver = 550` |
| 쿠팡 | vendorId당 5 rps, 넘으면 수 분~수십 분 차단 | `CALL_GAP_MS.coupang = 250`, 429 받으면 60초 쿨다운 |
| 아마존 | Listings 5 rps | `CALL_GAP_MS.amazon = 220` |
| 아임웹 | 버킷 25, 초당 2 회복 | `X-RateLimit-Remaining` 감시 (`openapi/imweb_client.js:7`) |
| eBay | 일일 호출 한도 | 명시적 pacer 없음 (남은 과제) |

쓰기는 앱 전체에서 한 번에 하나만 돕니다(`bulk_price_ipc.js` `exclusive`). 일괄 작업도 한 번에 하나입니다(`bulk_batch.js` `active`). **워커 풀로 쓰기를 병렬화하지 않습니다.**

### 1.3 재시도와 멱등성
- **5xx 재시도는 읽기에만 합니다.** 네이버 `naver_api.js:264-265` (`isRead`), eBay `ebay_api.js:110` (`method === 'GET'`, 429 포함), 쿠팡 `coupang_api.js:179` (GET 504 1회).
- **쓰기(POST/PUT/PATCH)는 5xx·타임아웃 뒤에 다시 보내지 않습니다.** 실제로 반영됐을 수 있으므로 다시 조회해 상태를 확인합니다.
- 처리되지 않았음이 확실한 응답만 쓰기도 다시 보냅니다. 네이버·아임웹은 429 뒤에 물러났다가 다시 보내고(`imweb_client.js:122`), 네이버·eBay·아임웹은 401(토큰 거부) 뒤에 토큰을 갱신해 1회 다시 보냅니다. 쿠팡 401 은 HMAC 키(180일 만료)나 PC 시계 문제라 다시 보내지 않습니다.
- **쓰기 직전 현재값을 다시 읽습니다.** `expectedPrice` / `expectedName` / `expectedRevision` / `expectedContents` 가 다르면 보내지 않고 `markPreSend` 로 "보내기 전 실패"를 표시합니다(`utils/api_error.js`).
- **작업 멱등성.** `bulk_batch.js` 가 jobId + sha256 digest 를 원자적으로 기록합니다. 같은 ID 로 다른 목록을 보내면 거부하고, 이미 전송을 시작한 작업은 다시 보내지 않습니다.
- **중복 등록 차단.** `utils/duplicate_guard.js`, eBay 는 SKU 저널과 게시 여부 확인(`ebay.js:145`).

### 1.4 사람 확인
canary(시험 상품 선등록)는 쓰지 않습니다. 대신 아래 장치가 있습니다.
- 쓰기 직전 현재값 재조회(§1.3)
- 변경폭 상한: 쿠팡은 기존가 대비 50% 인하·100% 인상까지(`coupang.js:529`), 환율 자동 가격은 1% 미만 변동은 건너뛰고 10% 넘게 바뀌면 사람이 검토(`fx_auto_price.js`)
- 일괄 등록 경고 확인, 결과 CSV

### 1.5 이미지
몰마다 받는 방식이 다릅니다. 같은 URL 에 다른 파일을 올리면 캐시 때문에 옛 이미지가 남을 수 있으니, 바꾼 이미지는 새 파일 이름이나 새 URL 로 올립니다.
- 네이버: 먼저 `POST /v1/product-images/upload` 로 네이버 CDN 에 올리고 그 URL 을 씁니다(`naver_products.js:287`).
- 쿠팡: `vendorPath` 에 외부에서 받을 수 있는 공개 URL.
- eBay: `inventory_item.product.imageUrls`.
- 일괄 이미지 수정은 URL 목록의 sha256 으로 충돌을 검사합니다(`bulk_image_service.js`).

---

## 2. 몰별 요약

### 2.1 네이버 스마트스토어 (`naver_api.js`, `naver_products.js`)
- 인증: `type=SELF`, `client_secret_sign = base64(bcrypt(clientId_timestamp, secret))`, bcryptjs.
- 토폴로지: **각 PC 에서 직접 호출.** 호출 IP 가 앱 허용 목록(최대 3개)에 있어야 합니다.
- 읽기: `GET /v2/products/origin-products/{no}`, 묶음 현재가 조회는 `POST /v1/products/search` (100건).
- 쓰기: `PUT /v2/products/origin-products/{no}` 로 원상품 전체를 다시 보냅니다. `bulk-update` 는 상대 증감만 되므로 판매가 지정에 쓰지 않습니다.
- 신규 복사등록: 템플릿 GET → 변환 → `POST /v2/products`.

### 2.2 쿠팡 Wing (`coupang_api.js`, `coupang.js`, `server/proxy.py`)
- 인증: HMAC-SHA256(CEA). **서명은 각 PC 에서** 합니다.
- 토폴로지: 쿠팡도 IP 허용 목록이 있어 Lightsail 의 **키를 모르는 릴레이**(`POST {proxyUrl}/coupang`)를 거칩니다. 키는 관리 서버 `/api/credentials` 에서 PC 로 내려옵니다.
- 승인완료 상품의 가격·재고: `PUT /vendor-items/{id}/prices/{value}`(필요하면 `forceSalePriceUpdate=true`), `PUT /vendor-items/{id}/quantities/{value}` (`coupang_api.js:339,354`). `PUT seller-products` 로 가격을 바꾸면 승인이 다시 걸립니다.
- 본문(상세 이미지 등): `GET seller-products/{id}` → 수정 → 전체 `PUT`. 30초 캐시가 아닌 지금 원본과 `expectedContents` 를 비교합니다(`coupang.js:577-585`).
- 응답이 HTTP 200 이어도 `code: ERROR` 면 실패로 봅니다.

### 2.3 eBay (`ebay_api.js`, `ebay.js`, `ebay_payload.js`, `ebay_bulk_prices.js`)
- **Inventory REST API** 를 씁니다. Inventory API 로 만든 리스팅은 Trading `ReviseFixedPriceItem` 으로 고칠 수 없습니다.
- 등록: `PUT inventory_item/{sku}` → `POST offer` → `publish`. 내리기: `withdraw`.
- 가격·수량: `POST bulk_update_price_quantity` (25건 묶음). 가격만 바꿀 때는 수량을 보내지 않습니다.
- Trading API 는 `GetMyeBaySelling`, `GetItem`, `bulk_migrate_listing`(레거시 이관)에만 씁니다.
- SKU 는 항상 `encodeURIComponent` 로 넣습니다.
- 토큰 스코프: `api_scope`, `sell.inventory`, `sell.account.readonly` (`ebay_api.js:3-7`). 주문·정산 API 를 쓰려면 재동의가 필요합니다.
- 서버: 계정 삭제 알림 `server/ebay_notify.py`, `ebay_queue.py` (공개 엔드포인트).

### 2.4 아마존 (`amazon_api.js`, `amazon.js`)
- Listings Items API `PATCH`. `productType` 은 기존 리스팅 값을 우선합니다(`amazon.js:954`).
- 접수(ACCEPTED)와 실제 반영 확인을 구분합니다.
- 일본은 판매자 ID 가 따로이고 브랜드 차단(BIL 982) 같은 제약이 있습니다.

### 2.5 아임웹 (`openapi/imweb_client.js`, `imweb_oauth.js`, `imweb_bulk.js`, `imweb_head_create.js`)
- **Open API** (`https://openapi.imweb.me`), OAuth2 인가코드 + refresh. v2 `api_key` 방식은 2026-10-05 이후 쓰지 않습니다.
- **앱+사이트당 살아 있는 토큰은 하나뿐입니다.** 쓰는 쪽이 둘이면 서로 토큰을 무효화하므로 `utils/imweb_lock.js` 로 직렬화합니다(같은 PC 안에서만 막음).
- 사이트: 본사몰(KR/US/JP 구역 `unitCode`)과 B2B몰.
- 쓰기: `PATCH /products/{no}/price`, `PATCH /products/{no}/option-details/{code}`, `PATCH /products/{no}`·`/options/{code}`·`/status` (form-data), 신규 `POST /products`.

---

## 3. 일괄 수정 흐름

```
[1] 목록 조회 ─ 몰별 어댑터, 필터·선택
[2] 현재가 불러오기 ─ 묶음 조회(네이버 100 · 아마존 20), eBay 는 SKU별 offer 조회
[3] 변경값 입력 ─ 사전 검사(정수·양수·10원 단위·변경폭 상한)
[4] 작업 기록 ─ jobId + digest (bulk_batch.js)
[5] 순차 전송 ─ 행마다: 현재값 재조회 → 비교 → 쓰기 1회 (재시도 없음)
[6] 결과 ─ 성공 / 보내기 전 실패 / 결과 불명(다시 조회 필요), 결과 CSV
```

결과 불명 행은 자동으로 다시 보내지 않습니다. 현재값을 다시 읽은 뒤 사람이 재처리합니다.

---

## 4. 오류 대응

| 증상 | 몰 | 대응 |
| :--- | :--- | :--- |
| HTTP 429 | 네이버·아임웹 | 물러났다가 다시 보냄(처리되지 않은 요청). 간격 유지 |
| HTTP 429 | 쿠팡 | 그 PC 에서 60초간 새 요청을 바로 거절(차단이 길어지는 것을 막음) |
| 5xx · 타임아웃 (쓰기) | 전체 | 다시 보내지 않음. 조회해서 반영 여부 확인 |
| 401 | 네이버·eBay·아임웹 | 토큰 갱신 후 1회 재전송 |
| 401 | 쿠팡 | 다시 보내지 않음. API 키(180일 만료)와 PC 시계 확인 |
| HTTP 200 + `code: ERROR` | 쿠팡 | 실패로 처리 |
| 승인 재요청됨 | 쿠팡 | 승인 상품 가격을 `seller-products` PUT 으로 보낸 경우. `vendor-items` 경로 사용 |
| 변경폭 초과 | 쿠팡 | 보내기 전에 막음(50% 인하·100% 인상). 두 번에 나눠 변경 |
| 25710 / 25702 / 25713 | eBay | 항목·offer 없음 → 미연결로 처리 |
| 이미지 받기 실패 | 쿠팡·eBay | 공개 URL 인지, 핫링크 차단이 없는지 확인 |
| 토큰이 갑자기 무효 | 아임웹 | 다른 프로그램이 같은 앱으로 토큰을 받았는지 확인(앱+사이트당 1개) |
