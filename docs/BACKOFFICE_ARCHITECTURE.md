# 백오피스(주문·CS·정산) 구조 설계안

> 2026-11-05 설계안. **2026-11-06 P1(읽기 허브)만 구현됨 → [§0](#0-p1-구현-현황-2026-11-06).** P2 이후(쓰기·정산)는 아직 설계안입니다.
> 대상은 네이버·쿠팡·eBay·아임웹 4몰의 14개 업무입니다(아마존 제외).
> 세 가지 구조안(지정 PC 워커 / Lightsail 허브 / VERY UP 앱 안 주문 탭)을 안전·운영 관점과 공수·적합성 관점에서 심사해 **지정 PC 워커**를 골랐습니다(8·7.5점 대 4~6.5점).
> 쓰기 원칙은 [MULTI_CHANNEL_BULK_EDIT_API_STRATEGY.md](MULTI_CHANNEL_BULK_EDIT_API_STRATEGY.md) §0·§1.3 을 따릅니다.
> MCP 는 쓰지 않습니다. 검토한 MCP 는 모두 공식 API 래퍼라, 기존 어댑터로 공식 API 를 직접 부릅니다.

## 0. P1 구현 현황 (2026-11-06)

설계안보다 작게 만들었습니다: `kakao-notify` 를 `ops/` 로 옮겨 넓혔고, SQLite·웹 화면·jobs·서버 리스는 쓰기를 시작하는 P2 에서 들입니다.

| 파일 | 하는 일 |
| :--- | :--- |
| `ops/notify.mjs` | 60초마다 4몰 주문·클레임·문의를 읽어 카톡으로 알림, 09:00 요약(생존 신호), 피드 5회 연속 실패 알림. 몰에는 쓰지 않음 |
| `ops/run-ops.bat` | 작업 스케줄러 '로그온 시'. 워커가 죽으면 60초 뒤 다시 띄움. 로그 `%APPDATA%\veryup-ops\ops.log` |
| `ops/setup-login.ps1` | 관리 서버 계정(`ops-worker`)을 DPAPI 로 저장 → `%APPDATA%\veryup-ops\login.json` |
| `ops/send-kakao.ps1` | 카톡 창에 붙여 넣고 Enter (멈춘 창은 5초 뒤 실패) |
| `ops/notify.test.mjs` | `node --test ops/notify.test.mjs` |

상태는 `%APPDATA%\veryup-ops\state.json` 하나입니다. 설정은 `%APPDATA%\very-up-ver2\veryup.env` 의 `OPS_ROOM`, `OPS_IMWEB_PROFILES`.

| 몰 | 읽는 곳 | 알림 |
| :--- | :--- | :--- |
| 네이버 | `last-changed-statuses`(24h 창, 끝 명시) → `product-orders/query`, `contents/qnas`, `pay-user/inquiries` | 새 주문(입금 대기 표시), 취소·반품·교환 요청, 취소 완료, 배송지 변경, 미답변 문의 |
| 쿠팡 | `v5 ordersheets`(ACCEPT), `v6 returnRequests`(UC·CANCEL, 24h), `v4 exchangeRequests`, `v5 onlineInquiries`·`callCenterInquiries` | 새 주문, 반품·출고중지 요청, 취소 완료, 교환 요청, 미답변·이관 문의 |
| eBay | Fulfillment `getOrders`(lastmodifieddate), Message API(UNREAD) | 새 주문(결제 대기 표시), 취소 요청·완료, 안 읽은 메시지. 반품·INR 은 다음 단계 |
| 아임웹 | CLI `order list`, `--order-section-status *_REQUEST`, `community qna list status=wait` | 새 주문(입금 대기 표시, 연동 주문 제외), 취소·반품·교환 요청, 미답변 Q&A |

eBay 는 refresh 때 scope 를 빼서 동의된 범위를 그대로 받습니다(`ebay_api.js` `scopes: ''`). 서버의 refresh token 이 `sell.fulfillment`(또는 `.readonly`)·`commerce.message` 로 동의돼 있어야 합니다.

---

## 1. 한 줄 요약

사무실 PC **한 대**에서 headless Node 워커(`ops/worker.mjs`)를 돌립니다. 이 워커는 VERY UP 의 기존 몰 어댑터를 그대로 import 해서 4몰의 주문·클레임·문의·정산을 **읽어** 로컬 SQLite 에 쌓고, 카톡으로 알립니다. 몰에 **쓰는** 일(발주확인·송장·클레임 결정·문의 답변)은 로컬 화면에서 사람이 승인한 것만 1회 보냅니다.

```
                 ┌──────────── 지정 PC (Naver 허용 IP · imweb CLI 로그인 · 카톡 PC판) ────────────┐
 네이버 ◀──직접──┤ ops/malls/naver.mjs   ─┐                                                     │
 쿠팡   ◀──직접──┤ ops/malls/coupang.mjs ─┤   ops/worker.mjs ── ops/db.mjs (ops.sqlite)           │
 eBay   ◀──직접──┤ ops/malls/ebay.mjs    ─┤   (폴링·스케줄)  └─ ops/jobs.mjs (쓰기 상태기계)      │──▶ 카톡방
 아임웹 ◀─CLI────┤ ops/malls/imweb.mjs   ─┘                   ops/web.mjs (127.0.0.1:7777 승인화면)│
                 └──────────────────────────────────┬───────────────────────────────────────────┘
                                                    │ 로그인·키 받기·쓰기 리스·승인자 확인
                                           Lightsail 관리 서버 (기존 + ops_lease)
```

### 왜 이 구조인가
- **새로 만들 것이 가장 적습니다.** 어댑터(`naver_api.js`, `coupang_api.js`, `ebay_api.js`, `openapi/imweb_client.js`)는 Electron 을 import 하지 않는 순수 Node 라서 앱 밖에서도 씁니다. 시스템 Node v24 에 내장된 `node:sqlite` 를 쓰므로 새 의존성이 없습니다.
- **리스팅과 분리됩니다.** 주문 쪽 장애가 VERY UP 리스팅 앱으로 번지지 않고, 그 반대도 마찬가지입니다.
- **토폴로지가 맞습니다.** 네이버 허용 IP(앱당 3개)와 아임웹 토큰 1개 제약을 지정 PC 한 대로 풉니다. 주문 개인정보가 서버를 거치지 않습니다.

---

## 2. 구성 요소

| 모듈 | 하는 일 | 재사용 | 새 코드 |
| :--- | :--- | :--- | :--- |
| `ops/worker.mjs` | 기동·스케줄. 주문·클레임·문의 60초, 기준정보 하루 1회, 정산 06:00, 부가세 월초, 정기 알림 09:00/12:00/15:30 | `utils/server_keys.js` (`serverLogin`, `fetchCredentials`), `kakao-notify/notify.mjs` 루프 패턴 | 약 170줄 |
| `ops/malls/naver.mjs` | 주문·클레임·문의·판매자정보·정산·부가세 경로 | `naver_api.js` (bcrypt 서명, 550ms pacer, 읽기만 재시도, 401 1회) | 약 120줄 |
| `ops/malls/coupang.mjs` | ordersheets, 상품준비중, 송장, 반품·교환, 문의, 매출내역 | `coupang_api.js` (HMAC, 250ms pacer, 429 쿨다운, 출고지·반품지 메서드) | 약 100줄 |
| `ops/malls/ebay.mjs` | Fulfillment 주문·송장, Finances(`apiz.ebay.com`), 정책 조회 | `ebay_api.js` (읽기만 재시도, 401 1회) | 약 80줄 |
| `ops/malls/imweb.mjs` | imweb CLI 실행: 주문, 송장, 클레임, Q&A, 택배사, 출고지 | `notify.mjs` 의 CLI 헬퍼 | 약 70줄 |
| `ops/db.mjs` | 스키마, upsert, 일일 백업, 오래된 문의 본문 지우기 | `node:sqlite` | 약 80줄 |
| `ops/jobs.mjs` | 쓰기 상태기계(§4) | `bulk_batch.js` 의 digest 개념, `duplicate_guard.js` 의 "확인 못 하면 중단" | 약 160줄 + 테스트 1개 |
| `ops/web.mjs` | 127.0.0.1 승인 화면: 발주확인, 발송(송장 엑셀), 클레임, 문의, 작업 목록, 정산 | `xlsx`, `theme.css` | 약 250줄 |
| `ops/kakao.mjs` | 알림. 몰·건수·주문번호 뒤 4자리·상품명만 | `kakao-notify/send-kakao.ps1` | 약 30줄 |
| `ops/carrier_map.json` | 사내 택배사 → 몰별 택배사 코드 | 몰 택배사 목록으로 검증 | JSON 1개 |
| `ops-실행.bat` | 작업 스케줄러 "로그온 시" 기동, 실패 시 1분 뒤 재시작 | `실행.bat` 구조 | 약 15줄 |
| 서버 `ops_lease` | 쓰기 리스 테이블 1개 + `POST /api/ops/lease` | 기존 staff 토큰 인증 | 약 40줄 |

외부 MCP(smartstore-mcp, ebay-mcp v2, mcp-soloseller)는 **경로·필드 참고용**으로만 씁니다. 그 코드의 POST 5xx 재시도, pacer 없음, `int(Retry-After)` 같은 결함은 옮기지 않습니다.

---

## 3. 14개 업무 × 4몰

| 업무 | 네이버 | 쿠팡 | eBay | 아임웹 | 방식 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 주문 조회 | `last-changed-statuses` → `product-orders/query` | `ordersheets` v5 (ACCEPT) | Fulfillment `getOrders` (재동의 필요) | CLI `order list/get` | 자동 읽기 |
| 발주확인 | `product-orders/confirm` | 상품준비중 처리 | 없음 | 없음 | 승인 쓰기 |
| 발송 처리(송장) | `product-orders/dispatch`, 지연 `delay` | 송장 업로드 (상품준비중 완료 뒤) | `shipping_fulfillment` | CLI `invoice create` | 승인 쓰기 |
| 취소·반품·교환 | 조회 + 승인·거부·보류 | 조회 → 반품 승인은 3단계 | 조회만, 처리는 Seller Hub | 조회 + CLI 승인·거부 | 승인 쓰기 / eBay 수동 |
| 이미지 업로드 | 기존 VERY UP | 기존 VERY UP | 기존 VERY UP | 기존 VERY UP | 해당 없음 (리스팅 담당) |
| 카테고리·태그·브랜드 | 기존 VERY UP | 기존 VERY UP | 기존 VERY UP | 기존 VERY UP | 해당 없음 (리스팅 담당) |
| 통합 문의 | `qnas`, `inquiries` 조회 + 답변 | 온라인·콜센터 문의 조회 + 답변 | 수동 (Seller Hub) | CLI `qna list/answer` | 자동 읽기 + 승인 쓰기 |
| 계정 | 판매자 정보 (주문·정산 권한 점검 겸) | 설정값, `testConnection` | Account API | CLI `auth status` | 자동 읽기 (헬스체크) |
| 채널 | `channels` | 해당 없음 | 해당 없음 (EBAY_US) | 설정값 (본사몰·B2B) | 자동 읽기 |
| 주소록 | 출고지·주소록 조회 | 출고지·반품지 조회 (기존 메서드) | 정책·위치 조회 | CLI `shipping-places` | 자동 읽기 / 수정은 수동 |
| 오늘출발 | `this-day-dispatch` 조회 → 발송표 맨 위, 마감 알림 | 해당 없음 | 해당 없음 | 해당 없음 | 자동 읽기 / 설정은 수동 |
| 택배사 | 택배사 목록으로 코드 검증 | 공식 코드표 | 정적 매핑 | CLI `parcel-companies` | `carrier_map.json` |
| 건별·일별 정산 | `settle/daily`, `settle/case` | 매출내역 | Finances 거래·지급 (재동의 필요) | 수동 (API 없음) | 자동 읽기 06:00 |
| 부가세 | `vat/daily`, `vat/case` | 수동 (Wing 다운로드) | 해당 없음 | 수동 | 네이버만 자동 |
| 수수료 | `commission-details` | 매출내역 수수료 필드 | 거래 수수료 필드 | 수동 | 자동 읽기 |

쿠팡 경로는 **공식 개발자 문서와 대조한 뒤에만** 켭니다. 지금 있는 참고 자료는 2021년 래퍼뿐이고, mcp-soloseller 의 경로는 공식과 다릅니다.
eBay 환불(`issue_refund`)처럼 돈이 나가는 쓰기는 구현하지 않습니다.

---

## 4. 쓰기 규칙 (jobs 상태기계)

```
staged ─승인─▶ approved ─리스 확인·재조회─▶ sending ─1회 전송─▶ sent ─재조회─▶ verified
                                │                       ├─4xx──────▶ failed
                                └─상태 바뀜─▶ skipped_changed  └─5xx·타임아웃─▶ unknown ─재조회─▶ verified / failed
```

1. **승인자 확인**: 승인할 때 본인 staff ID·비밀번호를 넣고, 워커가 `serverLogin` 으로 확인합니다. 비밀번호는 저장하지 않고 `approved_by` 만 남깁니다. jobs 행이 곧 감사 기록입니다.
2. **같은 대상에는 살아 있는 작업이 하나만**: `UNIQUE INDEX jobs_live(mall, kind, target) WHERE state NOT IN ('failed','skipped_changed')`. 문구가 달라도 같은 송장·클레임 결정·답변은 두 번 나가지 않습니다.
3. **쓰기 직전 재조회**: 클레임이 끼었거나, 송장이 이미 있거나, 이미 답변됐으면 보내지 않습니다(`skipped_changed`).
4. **재전송 금지**: `sending` 을 먼저 커밋하고 1회만 보냅니다. 5xx·타임아웃은 `unknown` 으로 두고 다음 폴링의 재조회로만 판정합니다. 30분 넘게 남으면 카톡으로 알립니다. 다시 보내려면 `failed` 로 닫고 새로 승인받아야 합니다.
5. **기동 시**: 남아 있는 `sending` 은 전부 `unknown` 으로 바꾸고 자동으로 이어 보내지 않습니다.
6. **두 단계 몰**: 네이버(발주확인 → 발송), 쿠팡(상품준비중 → 송장)은 단계마다 작업을 따로 만들고, 앞 단계가 `verified` 여야 다음 단계를 만들 수 있습니다.
7. **PC 간 단일 작성자**: 읽기는 `ops.json` 의 host 와 PC 이름이 같을 때만 돕니다. 쓰기는 서버 `ops_lease`(TTL 180초, 60초 갱신)를 쥐었을 때만 합니다. 서버가 죽어도 읽기·알림은 계속 돕니다.
8. **허용 목록**: 기본은 `--read-only` 입니다. `ops.json` 에 켠 몰×동작만 쓰고, 목록을 비우면 전체 정지입니다. 동작마다 실계정 1건 시범 → 판매자센터 화면 대조 → 켜기 순서입니다.

---

## 5. 저장소

`%APPDATA%/veryup-ops/ops.sqlite` 하나를 쓰고, 매일 파일을 복사해 백업합니다.

| 테이블 | 키 | 비고 |
| :--- | :--- | :--- |
| `orders` | (mall, line_id) | 네이버 productOrderId, 쿠팡 shipmentBoxId:vendorItemId, eBay lineItemId, 아임웹 orderSectionItemNo. **수령인 이름·주소·전화, 원문 응답은 저장하지 않음** (화면에서 필요할 때 실시간 조회) |
| `claims` | (mall, claim_id) | type cancel·return·exchange, 사유, `draft` |
| `inquiries` | (mall, kind, inquiry_id) | 본문은 답변 후 30일 뒤 지움, `draft` |
| `jobs` | id + `jobs_live` 부분 UNIQUE | §4 |
| `settlements` | (mall, kind, ref_id) | case·daily·fee·vat·payout, 구매자 필드 제거 |
| `cursors`, `notified`, `refdata`, `canned_replies` | | 커서는 성공 뒤에만 전진하고 10분 겹쳐 읽음. 시간은 UTC 로 저장 |

서버에는 `ops_lease(name PK, holder_staff, holder_pc, expires_at, renewed_at)` 한 줄만 둡니다.

---

## 6. 개인정보·보안

- 몰 자격증명은 서버에서 받아 **메모리에만** 둡니다. 워커 계정 로그인 정보는 Windows DPAPI 로 암호화해 두고, 재부팅 뒤 사람 입력 없이 다시 기동합니다.
- 카톡·로그에는 몰, 동작, ID, HTTP 상태만 남기고 이름·금액·주소·전화는 넣지 않습니다.
- 승인 화면은 `127.0.0.1` 에만 열고, 기동할 때마다 새 CSRF 토큰을 쓰고, Host 헤더를 검사합니다.
- 쿠팡 주문 데이터는 Lightsail 릴레이를 거치지 않습니다(지정 PC IP 를 Wing 허용 IP 에 추가). 서버 배포 때 `proxy.py` 실패 본문 기록과 `request_log.py` 본문 버퍼를 끕니다.
- 아임웹은 CLI 토큰만 씁니다. VERY UP 앱 토큰과 충돌하지 않습니다. 다른 PC 에서 `imweb auth login` 을 하면 토큰이 무효화되므로 하지 않습니다.

## 7. LLM 의 자리

LLM 은 **초안과 요약만** 합니다: 문의 답변 초안(한·영·일), 클레임 사유 초안, 아침 요약(지연 위험, 미답변, 열린 클레임, 정산 미매칭).
- 결과는 `inquiries.draft`, `claims.draft` 에만 씁니다.
- `ops/llm.mjs` 는 `jobs.mjs` 와 `malls/*.mjs` 를 import 하지 않으므로 **코드 구조상 쓰기 경로가 없습니다.** 몰로 나가는 문구는 늘 사람이 편집·승인한 값입니다.
- 입력에서 이름·전화·주소·이메일·주문번호를 가립니다. 문의 본문으로 프롬프트 인젝션이 들어와도 피해는 초안이 오염되는 데서 그칩니다.
- 처음에는 `canned_replies` 템플릿으로 운영하고, 부족하다는 근거가 생기면 붙입니다(P5).

---

## 8. 단계별 계획

| 단계 | 범위 | 공수(일) | 서버 배포 |
| :--- | :--- | :--- | :--- |
| P0 뼈대 | `ops/` 폴더, 스키마, PC 이름 검사, DPAPI 로그인 설정, 작업 스케줄러, 4몰 헬스체크 | 1 | 불필요 |
| P1 읽기 허브 | 4몰 주문·클레임·문의 폴링, 카톡 알림·정기 알림, 읽기 화면. 1주 병행해 판매자센터와 건수가 맞으면 `kakao-notify` 를 끔 | 3~4 | 불필요 |
| P2 발주확인·송장 | 서버 배포 1회(`ops_lease`, 본문 로깅 끄기, 미배포 pacer), `jobs.mjs` + 테스트, 송장 엑셀 미리보기·승인, 4몰 송장 | 3~4 | **필요 (별도 승인)** |
| P3 클레임·문의 | 네이버·아임웹 클레임 결정, 문의 답변, 쿠팡 문의·반품(경로 확정분), 답변 템플릿 | 3 | — |
| P4 정산 | 네이버 정산·수수료·부가세, 쿠팡 매출내역, eBay Finances, 월별 xlsx, 미매칭 알림. 한 달 대조 뒤 회계 자료로 사용 | 2 | — |
| P5 (선택) LLM 초안 | `ops/llm.mjs` | 1~2 | — |

---

## 9. 시작 전에 오너가 정할 것

- [ ] 지정 PC·예비 PC: 네이버 허용 IP 안의 공인 IP, imweb CLI 로그인, 카카오톡 상시 로그인, 자동 로그온, 절전 해제
- [ ] 네이버 커머스API 앱에 주문·클레임·문의·정산·부가세 권한이 열려 있는지 (지금까지는 상품 위주로 사용)
- [ ] 쿠팡 Wing 허용 IP 에 지정 PC 공인 IP 추가 (불가능하면 릴레이를 쓰되, 본문 로깅 끄기 배포 뒤에만 켬)
- [ ] 쿠팡 엔드포인트를 공식 문서로 확정: ordersheets v5(읽기 확정), 상품준비중, 송장 업로드, 반품·교환, 문의, 매출내역, 택배사 코드
- [ ] eBay 재동의: `EBAY_SCOPES` 에 `sell.fulfillment`, `sell.finances` 를 추가하고, 새 refresh token 을 관리 서버에 갱신
- [ ] 워커 계정: 운영 `STAFF_PLATFORMS=coupang,naver` 라서 staff 계정은 eBay 키를 못 받음 → 전용 admin 계정(기본안) 또는 `STAFF_PLATFORMS` 에 ebay 추가
- [ ] P2 직전 서버 배포 1회 승인
- [ ] imweb CLI 가 본사몰·B2B 두 사이트 모두에서 주문·송장·클레임·Q&A 를 다루는지 확인 (쓰기 시험은 1건)
- [ ] 송장 엑셀이 어느 프로그램에서 어떤 열로 나오는지, 실제로 쓰는 택배사 목록
- [ ] 수동으로 계속할 것에 합의: 아임웹 정산·부가세·수수료, 쿠팡 부가세, eBay 환불·취소·반품

## 10. 알려진 위험

- **지정 PC 가 단일 장애점입니다.** 꺼지면 폴링·알림·승인이 멈춥니다. 정기 카톡(09:00/12:00/15:30)이 오지 않으면 장애이고, 예비 PC 로 수동 인계합니다(imweb CLI 재로그인, `ops.json` host 변경, 네이버 IP 확인). 원장은 각 몰에 있으므로 그동안은 판매자센터에서 처리하고, 재기동하면 커서로 따라잡습니다.
- 서버가 다운되면 승인 쓰기만 멈춥니다(읽기·알림은 계속).
- 네이버 발송·클레임 쓰기 11/12 는 실계정에서 검증된 적이 없고, 쿠팡 경로는 미확정입니다. 1건 시범 규칙 때문에 일정이 밀릴 수 있습니다.
- 재조회와 전송 사이 몇 초 동안 판매자센터에서 같은 건을 처리하면 경합이 생깁니다. 대개 몰이 4xx(이미 처리됨)로 거절하고 사후 재조회에서 드러납니다.
- imweb CLI 출력이 바뀌면 파싱이 깨집니다. 버전을 고정하고, 실패하면 imweb 폴링만 멈추고 알립니다. `invoice create` 는 CLI 확인 토큰이 없어 워커 승인에만 의존합니다.
- `send-kakao.ps1` 은 UI 자동화라 카카오톡 업데이트에 약합니다. 기준 데이터는 웹 화면이고, 정기 알림 누락이 장애 신호를 겸합니다.

### 고르지 않은 안
- **Lightsail 허브**: 4몰 키·쓰기 권한·주문자 개인정보를 공인 호스트 한 대에 모으고, 서명 로직이 Node·Python 두 벌이 되며, 네이버 IP 슬롯과 imweb 두 번째 앱 심사가 1단계 앞을 막습니다.
- **VERY UP 앱 안 주문 탭**: 리스팅 앱의 회귀·크래시가 주문 중단으로 번지고, Electron 30 에서는 `node:sqlite` 를 못 써 JSON 저장소가 되며, 모든 PC 에 릴리스가 필요합니다.
