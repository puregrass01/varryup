## 베리업3 적용 현황 · 2026-09-29

사용자 요청에 따라 아래 문서의 Canary Testing / 시험 상품 선등록 단계는 구현 절차에서 제외합니다.
현재 구현 범위는 **판매가 일괄 수정 및 API KEY 탭 분리**입니다. 이미지·재고·상세내용의 일괄 변경은 이번 범위에 포함하지 않습니다.

- 상단: 신규등록 / 단일 상품 수정 / 상품 일괄 수정 / API KEY.
- API KEY: 네이버, 쿠팡, 아마존, 아임웹, eBay의 인증 입력·저장·연결 기능. 기존 입력 요소를 이동하여 기존 값을 유지합니다.
- 상품 일괄 수정: 쇼핑몰별 목록과 사진·상품명·SKU·옵션·현재가·변경가·처리 결과 표.
- 브랜드 / 차량·제조사 / 차종 / 상품 종류 드롭다운과 검색, 페이지 이동, 필터 결과 선택.
- 선택 상품 현재가 조회 후 개별 가격 입력 또는 동일 금액 일괄 입력. '선택 변경 저장'은 현재 필터에서 선택된 변경 행만 전송합니다.
- 쿠팡은 옵션 고정 ID별 행으로 펼쳐 가격을 수정합니다. 네이버·아임웹 B2B는 기본 판매가를 수정하고 옵션 가격은 유지합니다.
- 저장 직전 현재가 비교로 충돌을 차단하고 순차 처리합니다. 재고·이미지·배송설정 등 미변경 값은 유지합니다.
- 영문 아임웹은 USD 게시판 가격 문구를 갱신합니다. 한국어·일본어 게시판은 판매가 필드가 없어 목록만 제공합니다.
- 아마존은 접수(ACCEPTED)와 반영 확인을 구분합니다. 접수·오류·확인 필요 행은 현재가를 다시 읽은 뒤 재처리합니다.
- eBay 가격 조회에서는 자동 Inventory API 이관을 수행하지 않습니다. 미연결 상품은 단일 상품 수정 탭에서 먼저 연결해야 합니다.
- 아마존·eBay의 목록 동기화, 다음 상품부터 중단, 결과 CSV 내보내기를 제공합니다.
- API 호출은 현재 프로젝트의 플랫폼 어댑터를 사용합니다. 아래 예시 URL이나 고정 요청량 수치를 그대로 적용하지 않습니다.
- 실행 상태·입력값은 탭 전환 중 메모리에 유지되며 앱 재시작 후 자동 재개는 지원하지 않습니다. 결과 CSV를 저장할 수 있습니다.

사용 순서: 플랫폼 선택 → 목록 조회 → 필터·상품 선택 → 현재가 불러오기 → 판매가 입력 → 선택 변경 저장.
현재 구현 확인은 외부 전송 없는 모의 데이터와 문법 검사로 수행했으며, 운영 상품 가격은 변경하지 않았습니다.

---

# Multi-Channel E-Commerce Bulk Edit API Strategy & Automation Specification

> **Purpose:** Machine-readable specification and implementation standard for autonomous LLM agents and automation workers to execute bulk product data (images, prices, stock, descriptions) updates across multi-channel e-commerce marketplaces (eBay, Naver SmartStore, Coupang, Amazon SP-API, Imweb).

---

## 1. Core System Invariants & Global Rules

Any LLM agent or automated worker executing bulk updates across shopping platforms MUST enforce the following constraints:

### Rule 1.1: Cache-Busting for Image Assets (Mandatory)
* **Invariant:** Never update a product with an identical image URL string even if the underlying binary changed.
* **Mechanism:** All modified image assets must append a version tag or unique timestamp query parameter, or use a content-hashed filename.
  * Example: `https://static.example.com/items/OG101_v2.jpg` or `https://static.example.com/items/OG101.jpg?v=20260929`
  * Rationale: CDNs across eBay, Naver, and Coupang cache remote URLs aggressively; reusing URL strings causes stale image display lasting up to 30 days.

### Rule 1.2: Mutation Pattern Classification
Platforms follow one of two mutation semantics. An agent MUST NOT send a partial payload to a `Full Replace (PUT)` endpoint.
* **Type A (Partial Patch / RFC 6902):** The API accepts only the modified fields (e.g., Naver Commerce API `PATCH`, Amazon Listings Items API `PATCH`).
* **Type B (Full Replace / Read-Modify-Write):** The API requires the entire product representation. Sending only the diff will erase options, notices, and unmentioned fields (e.g., Coupang WING API `PUT`).

### Rule 1.3: Rate Limiting & Concurrency Matrix
| Platform | Max Concurrency | Safe Request Rate | Burst Handling |
| :--- | :--- | :--- | :--- |
| **eBay Trading API** | 6 - 8 workers | 15 req/sec | Exponential backoff on HTTP 429 / 5xx |
| **Naver Commerce API**| 3 - 5 workers | 10 req/sec | Backoff with 500ms jitter |
| **Coupang Open API**  | 2 - 4 workers | 5 req/sec | Strict serialization on same vendor ID |
| **Amazon SP-API**     | 1 - 2 workers | 2 req/sec (Leaky Bucket) | Respect `x-amzn-RateLimit-Limit` header |
| **Imweb Open API**    | 2 - 3 workers | 5 req/sec | Standard retry on 429 |

### Rule 1.4: Mandatory Canary Testing
* Before processing batch sizes $N > 1$, the agent MUST execute the update on exactly **1 test item**, verify the response status and live storefront rendering, and obtain affirmative health verification before proceeding with the remaining $N - 1$ items.

---

## 2. Platform-by-Platform API Specifications

```
                          [Master SKU Catalog]
                                   │
         ┌──────────────┬──────────┴───────────┬──────────────┐
         ▼              ▼                      ▼              ▼
     [eBay US]      [Naver]                [Coupang]       [Amazon]
  Trading API     Commerce API             WING API         SP-API
(ReviseFixed)   (PATCH /products)       (GET ➔ Modify ➔ PUT) (JSON Patch)
```

---

### 2.1 eBay US (Marketplace: `EBAY_US`)
* **Endpoint Type:** SOAP/XML Trading API (`https://api.ebay.com/ws/api.dll`) or Seller Hub Reports CSV.
* **Mutation Semantic:** Array Replacement for `PictureDetails`.
* **Important Behavior:** Specifying `PictureDetails.PictureURL` overwrites ALL existing photos. To replace only the 3rd image, the agent MUST submit `[Image1_URL, Image2_URL, NewImage3_URL]`.

#### API Payload: `ReviseFixedPriceItem`
```xml
<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>{{ITEM_ID}}</ItemID>
    <PictureDetails>
      <PictureURL>{{IMAGE_URL_1}}</PictureURL>
      <PictureURL>{{IMAGE_URL_2}}</PictureURL>
      <PictureURL>{{NEW_IMAGE_URL_3}}</PictureURL>
    </PictureDetails>
  </Item>
</ReviseFixedPriceItemRequest>
```

#### Batch Upload Semantic: Seller Hub Reports CSV
If using bulk CSV upload via Seller Hub Reports, supply ONLY the minimum necessary columns to prevent re-validation errors:
```csv
Action,ItemID,PicURL
Revise,{{ITEM_ID}},"{{IMAGE_URL_1}}|{{IMAGE_URL_2}}|{{NEW_IMAGE_URL_3}}"
```

---

### 2.2 Naver SmartStore (Marketplace: `NAVER`)
* **Endpoint:** `PATCH https://api.commerce.naver.com/external/v2/products/{originProductNo}`
* **Mutation Semantic:** Partial Patch (`Type A`).
* **Authentication:** OAuth2 Client Credentials (`client_id`, `client_secret` signed via bcrypt timestamp token).

#### API Payload:
```json
{
  "product": {
    "representativeImage": {
      "url": "{{MAIN_IMAGE_URL}}"
    },
    "optionalImages": [
      { "url": "{{OPTIONAL_IMAGE_URL_1}}" },
      { "url": "{{NEW_OPTIONAL_IMAGE_URL_2}}" }
    ],
    "detailContent": "<p><img src=\"{{DETAIL_HTML_IMAGE_URL}}\"/></p>"
  }
}
```

---

### 2.3 Coupang (Marketplace: `COUPANG`)
* **Endpoint:** 
  * Read: `GET https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/{sellerProductId}`
  * Write: `PUT https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/{sellerProductId}`
* **Mutation Semantic:** Read-Modify-Write (`Type B`).
* **Critical Rule:** NEVER send partial JSON to Coupang. Sending an incomplete payload wipes out shipping policies, required notice attributes, and unlisted option combinations.

#### Execution Protocol:
1. `GET /seller-products/{sellerProductId}` ➔ Extract full product JSON.
2. Locate `sellerProduct.images` array.
3. Update target image object by matching `imageOrder` or `imageType`:
   ```json
   "images": [
     { "imageOrder": 0, "imageType": "REPRESENTATION", "vendorPath": "{{MAIN_IMAGE_URL}}" },
     { "imageOrder": 1, "imageType": "DETAIL", "vendorPath": "{{DETAIL_IMAGE_URL_1}}" },
     { "imageOrder": 2, "imageType": "DETAIL", "vendorPath": "{{NEW_COMPARISON_IMAGE_URL}}" }
   ]
   ```
4. `PUT /seller-products/{sellerProductId}` with modified full payload.

---

### 2.4 Amazon US / Global (Marketplace: `AMAZON SP-API`)
* **Endpoint:** `PATCH https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds={marketplaceId}`
* **Mutation Semantic:** JSON Patch (RFC 6902) (`Type A`).
* **Supported Operations:** `replace`, `add`, `delete`.

#### API Payload:
```json
{
  "productType": "AUTO_PART",
  "patches": [
    {
      "op": "replace",
      "path": "/attributes/other_product_image_locator_2",
      "value": [
        {
          "media_location": "{{NEW_IMAGE_URL_3}}"
        }
      ]
    }
  ]
}
```
*Note: For batches > 500 items, use `POST /feeds/2021-06-30/feeds` with `JSON_LISTINGS_FEED` instead of synchronous single calls.*

---

### 2.5 Imweb (Marketplace: `IMWEB`)
* **Endpoint:** `PATCH https://api.imweb.me/v2/shop/products/{prod_no}`
* **Mutation Semantic:** Partial Patch (`Type A`).
* **Authentication:** Access Token via `GET /v2/auth/access-token` using `api_key` and `secret`.

#### API Payload:
```json
{
  "images": [
    "{{MAIN_IMAGE_URL}}",
    "{{DETAIL_IMAGE_URL_1}}",
    "{{NEW_IMAGE_URL_2}}"
  ],
  "content": "<p><img src=\"{{NEW_DETAIL_HTML_IMAGE}}\"/></p>"
}
```

---

## 3. End-to-End Bulk Mutation Algorithm

When an LLM agent or worker script executes an automated bulk update across any or all platforms, follow this state machine:

```
[State 0: Asset Ingestion]
        │ Upload local image binaries to HTTPS CDN / EPS
        ▼
[State 1: Catalog Resolution]
        │ Match Master SKU ➔ { eBay_ItemID, Naver_ID, Coupang_ID, Amazon_SKU }
        ▼
[State 2: Canary Verification (N=1)]
        │ Execute single call on Item[0] ➔ Verify 200 OK & storefront inspection
        ▼
[State 3: Concurrent Batch Execution]
        │ Worker pool with Rate Limiter & Jittered Exponential Backoff
        ▼
[State 4: Reconciliation & Dead Letter Queue (DLQ)]
        │ Output success report + retryable DLQ JSON for failed IDs
```

### Algorithm Pseudo-code:
```typescript
interface BulkJobConfig {
  channel: 'EBAY' | 'NAVER' | 'COUPANG' | 'AMAZON' | 'IMWEB';
  items: Array<{ masterSku: string; channelItemId: string }>;
  targetSlot: 'MAIN' | 'COMPARISON' | 'SUB_3';
  newAssetUrl: string;
}

async function runBulkRevision(job: BulkJobConfig) {
  // 1. Canary Test
  const canary = job.items[0];
  const canaryResult = await mutateChannelItem(job.channel, canary.channelItemId, job.targetSlot, job.newAssetUrl);
  if (!canaryResult.success) {
    throw new Error(`Canary failed on ${canary.channelItemId}: ${canaryResult.error}`);
  }

  // 2. Queue & Worker Pool
  const queue = [...job.items.slice(1)];
  const concurrency = getConcurrencyLimit(job.channel);
  const dlq: Array<{ itemId: string; error: string }> = [];
  const succeeded: string[] = [canary.channelItemId];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const res = await mutateChannelItemWithRetry(job.channel, item.channelItemId, job.targetSlot, job.newAssetUrl, 3);
        if (res.success) {
          succeeded.push(item.channelItemId);
        } else {
          dlq.push({ itemId: item.channelItemId, error: res.error });
        }
      } catch (err: any) {
        dlq.push({ itemId: item.channelItemId, error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { total: job.items.length, succeeded: succeeded.length, failed: dlq.length, dlq };
}
```

---

## 4. Failure Modes & Self-Healing Decision Tree

| Symptom / Error Code | Platform | Root Cause | Automated Recovery Action |
| :--- | :--- | :--- | :--- |
| `HTTP 429 Too Many Requests` | Any | Concurrency rate limit exceeded | Halt worker pool for $(2^attempt \times 1000) \text{ ms}$; reduce active concurrency by 50%. |
| `Error 21919303` | eBay | Image URL inaccessible or resolution < 500px | Verify image URL returns `HTTP 200` with `image/*` MIME before submitting; check dimensions. |
| `Vendor path error` | Coupang | Image not downloadable by Coupang crawler | Re-host image on publicly open CDN; disable hotlink protection. |
| `RFC 6902 invalid path` | Amazon | Attribute locator does not exist on schema | Inspect listing definition for product type; verify image locator index. |
| `Auth token expired` | Any | Access token exceeded TTL | Invoke OAuth refresh token routine immediately; retry original payload once. |
