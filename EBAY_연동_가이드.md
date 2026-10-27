# eBay 미국 API 연동

기존 VERY UP의 국가별 플랫폼 선택, 탭, 설정 입력, 상품 자동 입력, 작업 로그 템플릿을 유지합니다. 미국(EBAY_US), USD, 새 상품(NEW), 고정가(FIXED_PRICE), 단일 SKU를 지원합니다. 기본 환경은 Sandbox입니다.

## 시작하기

1. 개발 실행 중이라면 앱을 다시 실행합니다. 기존 설치 EXE는 소스 변경을 자동 반영하지 않으므로 새 빌드가 필요합니다.
2. VERY UP 현황판에서 **USA → 이베이**를 클릭하면 등록 폼이 바로 열립니다. 상단에 플랫폼명과 국가명이 표시됩니다.
3. eBay 탭에서 **연결 설정 열기**를 누르고 환경에 맞는 Client ID(App ID), Client Secret(Cert ID)을 저장합니다.
4. 다음 중 하나로 판매자 권한을 연결합니다.
   - **판매자 연결:** 개발자 포털에 OAuth 동의 완료 URL과 RuName을 등록하고, 앱에 RuName을 저장합니다. 판매자 연결 버튼으로 브라우저를 열어 동의한 뒤, 완료 페이지의 전체 URL(code와 state 포함)을 앱에 붙여넣고 연결 완료를 누릅니다. 요청 유효기간은 10분이며 eBay 인증 코드가 먼저 만료되면 다시 동의해야 합니다.
   - **직접 입력:** eBay 개발자 포털에서 해당 판매자의 OAuth Refresh Token을 발급받아 저장합니다. 임시 Access Token이나 기존 Auth'n'Auth 토큰을 입력하면 안 됩니다.
5. **연결 테스트 · 정책/출고지 조회**를 실행합니다. 각 입력란의 후보에서 미국 배송·결제·반품 정책과 출고지 키를 선택한 뒤 정책 설정을 저장합니다.

요청하는 OAuth 범위:

```text
https://api.ebay.com/oauth/api_scope
https://api.ebay.com/oauth/api_scope/sell.inventory
https://api.ebay.com/oauth/api_scope/sell.account.readonly
```

판매자 계정은 Business Policies에 가입되어 있어야 하며 배송·결제·반품 정책을 미리 만들어야 합니다. 정책/출고지 조회는 기존 항목을 읽습니다. 출고지가 없다면 eBay Inventory API의 `createInventoryLocation`을 개발자 API Explorer에서 실행해 준비하세요. 계산 배송비 정책에는 포장 무게와 크기 등 추가 정보가 필요할 수 있습니다.

Sandbox와 Production은 개발자 키, 토큰, 정책, 출고지가 서로 다릅니다. 환경이나 Client ID를 변경하면 기존 비밀정보가 제거되므로 해당 환경의 값으로 다시 연결하세요. Sandbox의 카테고리 검색 지원 범위에 따라 검색이 실패하면 카테고리 ID를 직접 입력하고 필수 속성을 조회하세요. 메타데이터 조회 실패를 검증 성공으로 처리하지 않습니다.

## 신규 상품 등록

1. 기존 왼쪽 공통 상품 입력을 실행하면 eBay 설명과 ESM 이미지 URL도 채워집니다. **SKU·영문 상품명·USD 가격은 자동 환산하거나 추측하지 않습니다.**
2. SKU를 좌·우, BSA, 세트/개별 등 실제 판매 단위마다 다르게 정합니다. 예: `OG-123-L-BSA`.
3. 상품 브랜드, 실제 제조사 부품번호, 가격, 재고, 상품명과 설명을 입력합니다. 호환 차량 제조사와 상품 브랜드를 혼동하지 마세요.
4. 영문 검색으로 미국 최하위 카테고리를 선택하고 필수 속성을 조회합니다. 필수 속성은 표시된 입력란, 추가·복수 속성은 JSON에 입력합니다. 동일한 속성이 두 곳에 있으면 값이 있는 필수 입력란이 우선하며, 별도의 브랜드/MPN 입력값이 최종 우선합니다.
5. 상품 사진 HTTPS URL을 한 줄에 하나씩 입력합니다. 첫 번째 URL이 대표 사진입니다. ESM 조견표만으로 실제 상품 사진을 대체하지 마세요. 설명은 일반 텍스트로 입력하며, HTML은 실행되지 않도록 이스케이프합니다.
6. **검증 · 미리보기**로 가격·수량·이미지·정책·카테고리 필수 속성을 확인합니다. 이는 eBay의 최종 게시 승인을 대체하지 않습니다.
7. **초안 저장**으로 Inventory Item과 미게시 Offer를 생성합니다. 아직 판매를 시작하지 않습니다.
8. **초안 게시**를 누르면 선택한 환경에 상품을 게시합니다. 로그의 Listing ID를 확인합니다.

신규 등록 경로는 기존 SKU의 상품을 덮어쓰지 않습니다. 저장된 초안을 같은 입력으로 다시 저장하면 중복 생성 대신 복구합니다. 저장 이후 입력값이나 정책 구성이 바뀌면 새 SKU를 사용해야 합니다. 이 버전은 저장된 초안의 전체 내용 수정 UI를 제공하지 않습니다.

## 기존 상품 관리

- 앱 상단의 상품수정 모드에서 미국 이베이를 선택하거나, eBay 탭의 작업 모드를 **기존 상품 관리**로 변경합니다.
- 정확한 SKU로 미국 고정가 Offer를 조회합니다. Seller Hub에서 수동 등록했거나 다른 API로 만든 상품을 자동 이전하지 않습니다.
- 게시된 상품은 **USD 가격과 미국 판매 수량**을 수정할 수 있습니다. 전체 재고와 다른 국가의 판매 수량은 변경하지 않으며, 미국 수량은 전체 재고 이하로 제한합니다.
- 앱에서 저장한 초안은 SKU 조회 후 게시할 수 있습니다.
- **판매 중단**은 확인 후 해당 미국 Offer를 내립니다. Inventory Item을 삭제하지 않습니다.

eBay 공식 문서상 Inventory API로 생성한 상품은 Seller Hub에서 수정할 수 없습니다. 운영 중 가격·판매 수량 외의 제목·설명·카테고리 등 전체 수정은 이 버전에 포함되지 않으므로, 필요한 운영 범위를 확인한 뒤 Production에 적용하세요.

## 저장과 오류 복구

- Electron `userData` 아래 `ebay_config.json`에 설정을 저장합니다. Client Secret과 Refresh Token은 Electron `safeStorage`로 Windows에서 암호화합니다. 암호화가 불가능하면 평문 저장 없이 실패합니다.
- 설정 조회는 인증정보의 저장 여부만 UI에 반환합니다. API 호출과 토큰 갱신은 메인 프로세스에서 실행합니다. 관리자 서버의 인증키 관리에서 eBay API 키를 등록하면 직원 앱 로그인 시 내려받고, Client Secret과 Refresh Token은 PC의 `safeStorage`로 다시 암호화하여 저장합니다.
- `ebay_jobs.json`은 SKU별 Offer ID, Listing ID, 요청 해시와 진행 상태를 저장합니다. 키는 환경·개발자 앱·판매자 토큰·마켓·SKU로 분리합니다. 토큰을 새로 발급받으면 이전 토큰으로 만든 초안의 소유권 자동 복구는 지원하지 않습니다. 기존 게시 상품의 SKU 조회와 가격·판매 수량 수정은 가능합니다.
- 작업 중 중복 클릭과 설정 변경을 차단합니다. 같은 계정 작업은 한 앱 인스턴스에서 실행하세요. 여러 PC 사이의 작업 잠금·재고 조율은 지원하지 않습니다.
- GET 조회의 429/5xx 응답은 제한적으로 재시도합니다. 생성·게시·수정 요청의 타임아웃이나 서버 오류는 자동 재전송하지 않습니다.
- Offer 생성 응답이 유실되면 같은 입력으로 초안을 다시 저장해 원격 SKU 상태를 조회합니다. 원격 Offer가 확인되면 복구하고, 아직 확인되지 않으면 추가 생성을 중단합니다.
- 게시 응답이 유실되면 SKU 조회 또는 게시 재실행으로 이미 게시된 상태를 확인할 수 있습니다. 여전히 결과가 불확실하면 다시 게시하지 않고 eBay 측 상태 확인을 요청합니다.
- 잘못된 정책 등 확정된 요청 오류는 로그에 표시합니다. 불확실한 작업 기록을 수동 삭제하면 중복 방지가 해제되므로 eBay 상태를 먼저 확인하세요.

## 관리자 서버 인증키 등록 (eBay / Amazon)

1. 관리자 계정으로 접속하여 **인증키 관리 → 인증키 추가 → 종류: API 키**를 선택합니다.
2. 플랫폼에서 **이베이 (ebay)** 또는 **아마존 (amazon)**을 선택하면 서버에서 정의한 JSON 입력 양식이 표시됩니다.
3. eBay는 `environment`, `clientId`, `clientSecret`, `refreshToken`을 입력합니다. 판매자 연결을 앱에서 진행하려면 `ruName`도 입력합니다. 출고지·배송·결제·반품 정책 ID도 함께 등록할 수 있습니다. 기본 환경은 `production`이며 테스트 키에는 `sandbox`를 지정합니다.
4. Amazon은 `sellerId`, `clientId`, `clientSecret`, `refreshToken`, `endpoint`, `marketplaceId`를 입력합니다. 기본 양식은 미국 마켓이며 일본은 `endpoint`를 `https://sellingpartnerapi-fe.amazon.com`, `marketplaceId`를 `A1VC38T7YXB528`로 설정합니다.
5. 저장 후 직원 앱에서 서버에 다시 로그인하면 `/api/credentials`로 키를 받아 각 플랫폼 설정에 반영합니다. 앱이 서버에 인증할 때 사용하는 직원 로그인 토큰과 마켓플레이스 인증키는 서로 별개입니다.

`ADMIN_SERVER_URL`은 관리자 서버 주소만 설정합니다. Amazon/eBay 키를 URL 상수에 넣지 않고 위 인증키 관리에서 등록합니다.

로컬 검증: `npm run test:server-credentials`, `npm run test:admin-credentials` (서버 Python 의존성 설치 필요).

## 서버 업로드 없이 사용하기 (기본 직접 호출)

eBay는 직원 로그인 여부와 관계없이 기본적으로 선택한 환경의 API(`api.ebay.com` 또는 `api.sandbox.ebay.com`)를 직접 호출합니다. 따라서 관리자 서버에 `/ebay`가 없어도 정책·출고지 조회와 상품 API를 사용할 수 있습니다. 저장된 Refresh Token을 그대로 사용하며 판매자 OAuth 연결을 다시 할 필요는 없습니다.

수정된 프로젝트의 앱을 완전히 종료한 뒤 `실행.bat` 또는 `npm start`로 다시 실행하고 **연결 테스트 · 정책/출고지 조회**를 누르세요. 기존 설치 EXE는 소스 수정을 자동 반영하지 않으므로 프로젝트 폴더에서 실행하거나 새로 빌드해야 합니다. 다른 플랫폼에도 영향을 주는 `USE_SERVER_PROXY=0`을 설정할 필요는 없습니다.

이 변경은 eBay 상품 API의 호출 경로만 바꿉니다. `/ebay/deletion`, `/updates/*`, `/ebay/auth/accepted` 등 별도 공개 서버 기능을 배포하거나 복구하지는 않습니다.

## 선택 사항: 서버 프록시 (쿠팡과 같은 전달 방식)

서버 배포 후 `USE_EBAY_PROXY=1`을 명시적으로 설정하면 직원 로그인 상태에서 eBay Sell/Taxonomy 요청이 `POST {ADMIN_SERVER_URL}/ebay`를 거칩니다. 기본 프록시 주소는 `https://admin.veryup-domain.duckdns.org/ebay`입니다. 기존 직원 로그인 토큰을 메모리에서 사용합니다. 로그인 전 또는 `USE_SERVER_PROXY=0`이면 직접 호출하며, 프록시 요청 실패 시 직접 호출로 재전송하지 않습니다. 프록시 경로가 없는 경우에는 eBay 오류와 구분해 관리자 서버의 배포 누락을 안내합니다.

- 외부 요청 헤더: `Authorization: Bearer <직원 토큰>`.
- JSON 본문: `{ "method": "GET", "url": "https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item?limit=1", "headers": { "Authorization": "Bearer <eBay Access Token>" } }`.
- 쓰기 요청의 `body`는 앱이 만든 JSON 문자열을 그대로 전달합니다. 서버는 eBay 응답 상태·본문·`Retry-After`를 유지합니다.
- 서버 허용 대상은 `api.ebay.com`, `api.sandbox.ebay.com`의 HTTPS 기본 포트뿐입니다. 다른 호스트·사용자 지정 포트·리디렉션을 거부합니다.
- eBay OAuth 동의 페이지와 토큰 교환/갱신은 앱에서 직접 요청합니다. Client Secret·Refresh Token은 이 프록시 요청에 포함하지 않습니다.
- 직원 토큰 만료/비활성화는 `proxyError`로 구분하고 다시 로그인을 안내합니다. eBay 토큰 갱신이나 상품 변경 재전송으로 처리하지 않습니다.

서버 배포 시:

1. `server/proxy.py`, `server/app.py`, `server/requirements.txt`를 관리자 서버에 반영하고, 서버의 Python 환경에서 `python -m pip install -r requirements.txt`를 실행합니다.
2. 기존 관리자 서버 서비스를 재시작합니다. 개발 실행 명령은 `server` 폴더에서 `python -m uvicorn app:app --host 0.0.0.0 --port 8001`입니다.
3. HTTPS 리버스 프록시가 기존 `/coupang`과 동일한 FastAPI 서비스로 `/ebay`, `/proxy/health`를 전달하도록 설정합니다. 호스트 전체를 8001 포트로 전달하는 기존 설정이라면 별도 경로 설정이 필요 없습니다.
4. 직원 토큰으로 `GET /proxy/health`를 요청해 `platforms`에 `ebay`가 포함되는지 확인한 뒤, 앱의 Sandbox 연결 테스트·정책/출고지 조회를 실행합니다.
5. 수정한 앱을 다시 실행하거나 새 설치본을 배포합니다.

`https://veryup-domain.duckdns.org/` 루트 주소는 이 저장소의 기본 관리자 주소와 다릅니다. 루트에서 관리자 FastAPI를 서비스하는 배포라면 앱의 `ADMIN_SERVER_URL`을 해당 루트 주소로 설정하세요. 루트의 실제 라우팅/배포 상태는 이번 로컬 검증에 포함되지 않습니다.

## 파일 구조

| 파일 | 역할 |
|---|---|
| `src/platforms/ebay_api.js` | OAuth 토큰, HTTP, 재시도, Inventory·Taxonomy 조회 |
| `src/platforms/ebay_payload.js` | 상품 검증과 미국 등록 데이터 변환 |
| `src/platforms/ebay_store.js` | 암호화 설정과 작업 기록 저장 |
| `src/platforms/ebay.js` | 초안·게시·조회·가격/수량 수정·판매 중단 |
| `src/ebay_ipc.js` | 기존 로컬 UI/부모 iframe과 메인 프로세스 연결 |
| `src/ui/ebay.js`, `ebay.css` | 기존 템플릿을 사용하는 eBay 탭 |
| `tests/ebay.test.mjs` | 네트워크 모의 응답을 사용하는 기능·오류 복구 테스트 |
| `tests/ebay-ui.mjs` | Chrome에서 기존 전체 UI와 iframe을 확인하는 오프라인 테스트 |

## 검증

```powershell
node --test tests/ebay.test.mjs tests/ebay-proxy.test.mjs
python -m unittest discover -s tests -p test_proxy.py -v
node tests/ebay-ui.mjs
```

npm이 설치되어 있으면 `npm run test:ebay`, `npm run test:ebay-ui`도 가능합니다. UI 테스트는 설치된 Chrome을 기본 사용하며 `EBAY_TEST_BROWSER`로 다른 Chromium 실행 파일을 지정할 수 있습니다. 외부 웹 요청을 차단하고 모의 IPC를 사용하므로 실제 상품은 생성하지 않습니다. 테스트용 파일 URL 접근 옵션은 이 테스트에만 적용되며 앱 설정을 바꾸지 않습니다.

실제 판매자 키와 토큰을 사용한 Sandbox 등록·Production 게시, Windows 실계정 암호화 저장, 설치 EXE 빌드는 별도 확인이 필요합니다. 구조화된 차량 호환표, 다중 옵션, 대량 등록, 주문 수집, 중앙 재고 동기화는 이번 범위에 포함되지 않습니다.

## 참고한 eBay 공식 문서

- [판매자 OAuth 연결](https://developer.ebay.com/develop/guides/sell/authorization)
- [게시 필수 항목](https://developer.ebay.com/api-docs/sell/static/inventory/publishing-offers.html)
- [상품에서 Offer까지](https://developer.ebay.com/api-docs/sell/static/inventory/inventory-item-to-offer.html)
- [카테고리와 상품 속성](https://developer.ebay.com/api-docs/sell/static/metadata/sell-categories.html)
- [출고지 관리](https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html)
- [가격·수량 수정](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/bulkUpdatePriceQuantity)
- [Inventory API 운영 제약](https://www.developer.ebay.com/api-docs/sell/inventory/static/overview.html)
