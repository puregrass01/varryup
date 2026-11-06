// 4몰(네이버·쿠팡·eBay·아임웹) 새 주문·클레임·문의 → PC 카톡 단톡방 알림. 몰에는 아무것도 쓰지 않는다(읽기만).
// 실행: ops/run-ops.bat (작업 스케줄러 '로그온 시'). 직접 돌릴 때:
//   node --env-file-if-exists=%APPDATA%\very-up-ver2\veryup.env ops/notify.mjs [--room 방] [--once] [--dry-run] [--preview] [--only naver]
//   --room       카톡 방 이름(창 제목). 없으면 veryup.env 의 OPS_ROOM
//   --dry-run    카톡 대신 화면에 출력(상태 파일은 바꾸지 않는다)
//   --preview    피드마다 최신 1건을 테스트 머리글을 붙여 바로 보내 봄(기록은 안 바꿈)
//   --only X     이름이 X 로 시작하는 피드만(naver, coupang, ebay, imweb, imweb.b2b ...)
// 첫 실행은 지금 보이는 건을 "본 것"으로만 기록하고 보내지 않는다. 그 뒤로는 꺼져 있던 동안 밀린 건도 보낸다.
// 관리 서버 계정은 ops/setup-login.ps1 로 한 번 저장한다(DPAPI). 없으면 아임웹만 돈다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { serverLogin, fetchCredentials } from '../src/utils/server_keys.js';
import { writeJsonAtomic } from '../src/utils/json_file.js';
import { NaverAPI } from '../src/platforms/naver_api.js';
import { CoupangAPI } from '../src/platforms/coupang_api.js';
import { EbayAPI } from '../src/platforms/ebay_api.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(process.env.APPDATA || homedir(), 'veryup-ops');
const STATE = join(DATA, 'state.json');
const LOGIN = join(DATA, 'login.json');
const IMWEB = process.env.IMWEB_BIN || join(homedir(), '.local', 'bin', 'imweb.exe');
const MINUTE = 60e3;
const DAY = 24 * 60 * MINUTE;
const H9 = 9 * 60 * MINUTE;
const FAIL_ALERT = 5; // 같은 피드가 이만큼 연속 실패하면 카톡으로 알린다

// ── 시각·문구 ──────────────────────────────────────────────
export const kstIso = (ms) => new Date(Math.floor(ms / 1000) * 1000 + H9).toISOString().replace('Z', '+09:00');
export const kstDate = (ms) => new Date(ms + H9).toISOString().slice(0, 10);
const kstMinute = (ms) => new Date(ms + H9).toISOString().slice(0, 16);
const kstSecond = (ms) => new Date(ms + H9).toISOString().slice(0, 19);
// 시간대가 없는 문자열(쿠팡 '2026-11-06T10:00:00')은 이미 한국 시각이라 그대로 보여 준다.
const when = (t) => (!t ? '' : typeof t === 'string' && !/(Z|[+-]\d\d:?\d\d)$/.test(t)
  ? t.replace('T', ' ').slice(0, 16)
  : new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
const money = (n, cur = 'KRW') => (n == null || n === '' ? '' : cur === 'KRW'
  ? `${Number(n).toLocaleString('ko-KR')}원` : `${Number(n).toLocaleString('en-US')} ${cur}`);
const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (...xs) => xs.flat().filter(Boolean).join('\n');
const dot = (...xs) => xs.filter(Boolean).join(' · ');
const failing = (name, mall, e) => ({ name, mall, async poll() { throw e; } }); // 키를 못 받은 몰도 실패 알림·요약에 보이게

// ── 네이버 ─────────────────────────────────────────────────
// 변경 주문 창: 직전 끝부터 지금-5초까지, 한 번에 24시간 이하(넘으면 400). 공식 FAQ 권장대로 끝을 늘 명시하고
// 다음 창은 직전 끝에서 시작한다(양 끝 포함이라 겹치는 건 seen 이 거른다). PC 시계는 Windows 시간 동기화를 켜 둔다.
export function naverWindows(lastTo, now) {
  const end = Math.floor((now - 5000) / 1000) * 1000;
  const out = [];
  for (let from = lastTo; from < end; from = out.at(-1)[1]) out.push([from, Math.min(from + DAY, end)]);
  return out;
}
const NAVER_LABEL = { PAYED: '새 주문', PAY_WAITING: '새 주문 · 입금 대기', CLAIM_COMPLETED: '취소 완료', DELIVERY_ADDRESS_CHANGED: '배송지 변경' };
const NAVER_CLAIM = { CANCEL: '취소', RETURN: '반품', EXCHANGE: '교환', ADMIN_CANCEL: '직권 취소', PURCHASE_DECISION_HOLDBACK: '구매확정 보류' };
// 발주확인 전 구매자 취소는 즉시 환불돼 CLAIM_REQUESTED 없이 CLAIM_COMPLETED 로만 남는다. 부분 취소면 남은 수량은 보내야 한다.
export const naverWanted = (e) => e.lastChangedType in NAVER_LABEL
  ? e.lastChangedType !== 'CLAIM_COMPLETED' || e.claimType === 'CANCEL'
  : e.lastChangedType === 'CLAIM_REQUESTED';
// 피드는 상품주문마다 마지막 변경 하나만 남긴다. 결제 뒤 같은 창 안에 배송지 변경·선물 수락 등이 오면 PAYED 가 가려지므로,
// 결제일이 이번 창 안이고 아직 결제완료 상태면 '새 주문'으로 본다.
const naverMasked = (e, since) => e.lastChangedType !== 'PAYED' && e.lastChangedType !== 'PAY_WAITING'
  && e.productOrderStatus === 'PAYED' && e.paymentDate && Date.parse(e.paymentDate) >= since;

export function naverOrderText(e, d = {}, masked = false) {
  const o = d.order || {}, p = d.productOrder || {}, a = p.shippingAddress || {};
  const c = Object.values(d.currentClaim || {}).find(Boolean) || {};
  const claim = e.lastChangedType === 'CLAIM_REQUESTED' || e.lastChangedType === 'CLAIM_COMPLETED';
  const kind = masked ? `새 주문${e.lastChangedType === 'DELIVERY_ADDRESS_CHANGED' ? ' · 배송지 변경됨' : ''}`
    : e.lastChangedType === 'CLAIM_REQUESTED' ? `${NAVER_CLAIM[e.claimType] || e.claimType || '클레임'} 요청` : NAVER_LABEL[e.lastChangedType];
  const qty = claim ? (c.requestQuantity ?? p.quantity) : (p.remainQuantity ?? p.quantity);
  const rest = claim && p.remainQuantity != null && p.remainQuantity !== p.quantity ? ` (남은 ${p.remainQuantity})` : '';
  const reason = dot(c.cancelReason || c.returnReason || c.exchangeReason, c.cancelDetailedReason || c.returnDetailedReason || c.exchangeDetailedReason);
  return lines(
    `[네이버 ${kind}] ${e.orderId}`,
    dot(o.ordererName, o.ordererTel, money(p.totalPaymentAmount), when(e.lastChangedDate)),
    p.productName && `- ${p.productName}${p.productOption ? ` [${p.productOption}]` : ''} x${qty ?? ''}${rest}`,
    reason && `사유: ${reason}`,
    [a.name, a.tel1, a.baseAddress, a.detailedAddress].filter(Boolean).join(' '),
  );
}

function naverFeeds(api) {
  const get = (path, q) => api.request('GET', `${path}?${new URLSearchParams(q)}`); // '+09:00' 의 + 는 %2B 로 가야 한다
  const empty404 = (e) => { if (e.status === 404) return null; throw e; };           // Q&A 는 '데이터 없음'을 404 로 준다
  return [{
    name: 'naver.order', mall: '네이버',
    async poll(st, now) {
      const since = st.cursor ?? now - 10 * MINUTE;
      const events = [];
      let end = since;
      for (const [from, to] of naverWindows(since, now)) {
        let q = { lastChangedFrom: kstIso(from), lastChangedTo: kstIso(to), limitCount: 300 };
        for (;;) {
          const { data } = await get('/v1/pay-order/seller/product-orders/last-changed-statuses', q);
          events.push(...(data?.lastChangeStatuses || []));
          if (!data?.more) break;
          q = { ...q, lastChangedFrom: data.more.moreFrom, moreSequence: data.more.moreSequence };
        }
        end = to;
      }
      const wanted = events.filter((e) => naverWanted(e) || naverMasked(e, since));
      const ids = [...new Set(wanted.map((e) => e.productOrderId))];
      const detail = new Map();
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await api.request('POST', '/v1/pay-order/seller/product-orders/query', { productOrderIds: ids.slice(i, i + 300) });
        for (const d of data || []) detail.set(d.productOrder?.productOrderId, d);
      }
      return {
        items: wanted.map((e) => ({ id: `${e.productOrderId}|${e.lastChangedType}|${e.lastChangedDate}`, text: naverOrderText(e, detail.get(e.productOrderId), naverMasked(e, since)) })),
        cursor: end,
      };
    },
  }, {
    // ponytail: 미답변 문의는 최근 3일 창으로만 본다. 3일 넘게 꺼져 있었으면 그 전 문의는 판매자센터에서 본다.
    name: 'naver.qna', mall: '네이버', open: 'inquiry',
    async poll(st, now) {
      const rows = [];
      for (let page = 1; ; page++) {
        const r = await get('/v1/contents/qnas', { fromDate: kstIso(now - 3 * DAY), toDate: kstIso(now), answered: false, page, size: 100 }).catch(empty404);
        rows.push(...(r?.contents || []));
        if (!r || r.last !== false) break;
      }
      return { items: rows.map((x) => ({ id: `q${x.questionId}`, text: lines(`[네이버 상품 문의] ${x.productName || ''}`, dot(x.maskedWriterId, when(x.createDate)), plain(x.question).slice(0, 300)) })) };
    },
  }, {
    name: 'naver.inquiry', mall: '네이버', open: 'inquiry',
    async poll(st, now) {
      const rows = [];
      for (let page = 1; ; page++) {
        const r = await get('/v1/pay-user/inquiries', { startSearchDate: kstDate(now - 3 * DAY), endSearchDate: kstDate(now), answered: 'false', page, size: 200 });
        rows.push(...(r.content || []));
        if (page >= (r.totalPages || 1)) break;
      }
      return { items: rows.map((x) => ({ id: `i${x.inquiryNo}`, text: lines(`[네이버 고객 문의] ${dot(x.category, x.title)}`, dot(x.customerName, x.productName, when(x.inquiryRegistrationDateTime)), plain(x.inquiryContent).slice(0, 300)) })) };
    },
  }];
}

// ── 쿠팡 ───────────────────────────────────────────────────
// 쿼리는 공식 예시처럼 손으로 만든다(':' 는 그대로, '+' 만 %2B). 서명도 이 문자열 그대로 한다.
// shipmentBoxId 는 18자리라 JSON.parse 에서 값이 깨진다 → 키로 쓰지 않는다.
function coupangFeeds(api, vid) {
  const get = (path, q) => api._request('GET', `/v2/providers/openapi/apis/api${path}?${Object.entries(q).map(([k, v]) => `${k}=${v}`).join('&')}`);
  const pages = async (path, q, pageSize) => {
    const rows = [];
    for (let pageNum = 1; ; pageNum++) {
      const { data } = await get(path, { ...q, pageSize, pageNum });
      rows.push(...(data?.content || []));
      if (pageNum >= (data?.pagination?.totalPages || 1)) return rows;
    }
  };
  const tokens = async (path, q) => {
    const rows = [];
    for (let token = ''; ;) {
      const r = await get(path, token ? { ...q, nextToken: token } : q);
      rows.push(...(r.data || []));
      if (!(token = r.nextToken || '')) return rows;
    }
  };
  return [{
    // 결제 후 목록에 나오기까지 쿠팡 쪽에서 10분쯤 걸린다. 결제완료(ACCEPT)는 발주확인하면 빠지므로 7일 창이 곧 '처리 대기'다.
    name: 'coupang.order', mall: '쿠팡', open: 'order',
    async poll(st, now) {
      const rows = await tokens(`/v5/vendors/${vid}/ordersheets`, { createdAtFrom: `${kstDate(now - 7 * DAY)}%2B09:00`, createdAtTo: `${kstDate(now)}%2B09:00`, status: 'ACCEPT', maxPerPage: 50 });
      return {
        items: rows.map((x) => {
          const its = x.orderItems || [], r = x.receiver || {};
          return {
            id: `o${x.orderId}:${its.map((i) => i.vendorItemId).join(',')}`,
            text: lines(
              `[쿠팡 새 주문] ${x.orderId}`,
              dot(x.orderer?.name, money(its.reduce((n, i) => n + Number(i.orderPrice?.units ?? i.orderPrice ?? 0), 0)), when(x.orderedAt)),
              its.map((i) => `- ${i.vendorItemName || i.sellerProductName} x${i.shippingCount}`),
              [r.name, r.safeNumber || r.receiverNumber, r.addr1, r.addr2].filter(Boolean).join(' '),
            ),
          };
        }),
      };
    },
  }, {
    // ponytail: 반품·취소는 분단위(timeFrame) 최근 24시간 창이다. 하루 넘게 꺼져 있던 동안의 요청은 판매자센터에서 본다.
    name: 'coupang.claim', mall: '쿠팡', open: 'claim',
    async poll(st, now) {
      const win = { searchType: 'timeFrame', createdAtFrom: kstMinute(now - DAY + MINUTE), createdAtTo: kstMinute(now) };
      const items = [];
      let done = 0;
      // UC(반품 미확인)에는 출고중지요청(RU)도 들어 있다. cancelType=CANCEL 은 결제완료 단계에서 이미 취소된 주문이다.
      for (const [extra, kind] of [[{ status: 'UC' }, '반품 요청'], [{ cancelType: 'CANCEL' }, '취소 완료']]) {
        const { data } = await get(`/v6/vendors/${vid}/returnRequests`, { ...win, ...extra });
        for (const x of data || []) {
          const stop = x.receiptStatus === 'RELEASE_STOP_UNCHECKED' || x.releaseStopStatus === '미처리';
          if (kind === '취소 완료') done++;
          items.push({
            id: `r${x.receiptId}`,
            text: lines(`[쿠팡 ${stop ? '출고중지 요청' : kind}] ${x.orderId}`, stop && '발송 전이면 출고를 멈추세요', dot(x.requesterName, when(x.createdAt)),
              (x.returnItems || []).map((i) => `- ${i.vendorItemName} x${i.cancelCount ?? i.purchaseCount ?? ''}${i.cancelCount != null && i.purchaseCount != null && i.cancelCount !== i.purchaseCount ? ` (주문 ${i.purchaseCount}개 중)` : ''}`),
              (x.cancelReasonCategory2 || x.cancelReason) && `사유: ${dot(x.cancelReasonCategory2, x.cancelReason)}`),
          });
        }
      }
      const ex = await tokens(`/v4/vendors/${vid}/exchangeRequests`, { createdAtFrom: kstSecond(now - 6 * DAY), createdAtTo: kstSecond(now), status: 'RECEIPT' });
      for (const x of ex) items.push({
        id: `e${x.exchangeId}`,
        text: lines(`[쿠팡 교환 요청] ${x.orderId}`, dot(x.exchangeAddressDtoV1?.returnCustomerName, when(x.createdAt)),
          (x.exchangeItemDtoV1s || []).map((i) => `- ${i.targetItemName} x${i.quantity ?? ''}`)),
      });
      return { items, open: items.length - done };
    },
  }, {
    name: 'coupang.inquiry', mall: '쿠팡', open: 'inquiry',
    async poll(st, now) {
      const win = { vendorId: vid, inquiryStartAt: kstDate(now - 6 * DAY), inquiryEndAt: kstDate(now) }; // 7일 이하
      const online = await pages(`/v5/vendors/${vid}/onlineInquiries`, { ...win, answeredType: 'NOANSWER' }, 50);
      const items = online.map((x) => ({
        id: `n${x.inquiryId}`,
        text: lines(`[쿠팡 상품 문의] 주문 ${(x.orderIds || []).join(',') || '-'}`, when(x.inquiryAt), plain(x.content).slice(0, 300)),
      }));
      for (const [status, tag] of [['NO_ANSWER', ''], ['TRANSFER', ' · 확인만']]) {
        for (const x of await pages(`/v5/vendors/${vid}/callCenterInquiries`, { ...win, partnerCounselingStatus: status }, 30)) {
          // 상위 content 는 '상담이력' 같은 제목뿐이고, 실제 이관 내용은 상담원 답글에 있다.
          const r = (x.replies || []).filter((y) => y.answerType === 'csAgent').at(-1);
          items.push({
            id: `c${x.inquiryId}`,
            text: lines(`[쿠팡 고객센터 문의${tag}] ${x.itemName || ''}`, dot(x.orderId && `주문 ${x.orderId}`, x.receiptCategory, x.buyerPhone, when(x.inquiryAt)), plain(r?.content || x.content).slice(0, 300)),
          });
        }
      }
      return { items };
    },
  }];
}

// ── eBay ───────────────────────────────────────────────────
// 워커는 refresh 때 scope 를 빼서 동의된 범위를 그대로 받는다(ebay_api.js scopes:''). 리스팅 앱은 지금처럼 EBAY_SCOPES 3개.
// refresh token 이 sell.fulfillment(.readonly)·commerce.message 로 동의돼 있지 않으면 403 이 FAIL_ALERT 번 뒤 카톡으로 온다.
function ebayFeeds(api) {
  return [{
    name: 'ebay.order', mall: 'eBay',
    async poll(st, now) {
      const since = new Date((st.cursor ?? now) - 10 * MINUTE).toISOString(); // 10분 겹쳐 읽고 seen 으로 거른다
      const orders = [];
      for (let offset = 0; ; offset += 200) {
        const r = await api.request('GET', `/sell/fulfillment/v1/order?filter=${encodeURIComponent(`lastmodifieddate:[${since}..]`)}&limit=200&offset=${offset}`);
        orders.push(...(r.orders || []));
        if (!r.orders?.length || orders.length >= (r.total || 0)) break;
      }
      const items = [];
      for (const o of orders) {
        const to = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {}, a = to.contactAddress || {};
        const body = [
          dot(o.buyer?.username, to.fullName, money(o.pricingSummary?.total?.value, o.pricingSummary?.total?.currency), when(o.creationDate)),
          (o.lineItems || []).map((i) => `- ${i.title} x${i.quantity}`),
          [to.primaryPhone?.phoneNumber, a.addressLine1, a.addressLine2, a.city, a.stateOrProvince, a.postalCode, a.countryCode].filter(Boolean).join(' '),
        ];
        // 발송 전(NOT_STARTED)만 새 주문으로 본다 — 이미 보낸 옛 주문이 수정돼도 '새 주문'으로 울리지 않게.
        // 결제 대기·실패는 따로 표시하고, 나중에 결제되면 '새 주문'이 한 번 더 온다(네이버 입금 대기와 같다).
        const pay = o.orderPaymentStatus, unpaid = pay === 'PENDING' || pay === 'FAILED';
        if (o.orderFulfillmentStatus === 'NOT_STARTED') {
          items.push({ id: `n${o.orderId}${unpaid ? `:${pay}` : ''}`, text: lines(`[eBay 새 주문${unpaid ? ` · ${pay === 'FAILED' ? '결제 실패' : '결제 대기'}` : ''}] ${o.orderId}`, body) });
        }
        // getOrders 의 cancelRequests 는 늘 비어 있지만 cancelState 는 온다. 사유는 Seller Hub 에서 본다.
        const cs = o.cancelStatus?.cancelState;
        if (cs && cs !== 'NONE_REQUESTED') items.push({ id: `c${o.orderId}:${cs}`, text: lines(`[eBay 취소 ${cs === 'CANCELED' ? '완료' : '요청'}] ${o.orderId}`, body) });
      }
      return { items, cursor: now };
    },
  }, {
    // ponytail: 안 읽은 대화 첫 50개만 본다. 50개를 넘게 쌓아 두는 일이 생기면 offset 으로 넘긴다.
    name: 'ebay.message', mall: 'eBay', open: 'inquiry',
    async poll() {
      const r = await api.request('GET', '/commerce/message/v1/conversation?conversation_type=FROM_MEMBERS&conversation_status=UNREAD&limit=50');
      return {
        items: (r.conversations || []).map((c) => {
          const m = c.latestMessage || {};
          return { id: `${c.conversationId}|${m.messageId || m.createdDate}`, text: lines(`[eBay 메시지] ${c.conversationTitle || ''}`, dot(m.senderUsername, when(m.createdDate)), plain(m.messageBody).slice(0, 300)) };
        }),
      };
    },
  }];
}

// ── 아임웹 (CLI 토큰. VERY UP 앱 토큰과 겹치지 않는다. 다른 PC 에서 같은 사이트로 CLI 로그인하면 이 토큰이 죽을 수 있다) ──
const imwebCli = (...args) => JSON.parse(execFileSync(IMWEB, ['--output', 'json', '--retry', '2', ...args], { encoding: 'utf8', timeout: 120000 })).data.list;
const LINKED = new Set(['SMARTSTORE', 'COUPANG']); // 네이버·쿠팡 연동 주문은 그쪽 피드가 알린다
const PAID = new Set(['PAYMENT_COMPLETE', 'PARTIAL_REFUND_COMPLETE', 'REFUND_PROCESSING']);
const DEAD = new Set(['CANCEL_COMPLETE', 'RETURN_COMPLETE']);

function imwebItems(sections) {
  return sections.flatMap((s) => s.sectionItems || []).map((i) => {
    const o = Object.values(i.productInfo?.optionInfo || {}).join('/');
    return `- ${i.productInfo?.prodName}${o ? ` [${o}]` : ''} x${i.qty}`;
  });
}
function imwebWhere(sec = {}) {
  const d = sec.delivery || {};
  const call = String(d.receiverCall || '').replace(/^(0\d{1,2})(\d{3,4})(\d{4})$/, '$1-$2-$3');
  const abroad = d.country && d.country !== 'KR'; // 국내는 addr1 에 시·도가 들어 있다
  return [d.receiverName, call, d.addr1, d.addr2, ...(abroad ? [d.city, d.state, d.zipcode, d.countryName || d.country] : [])].filter(Boolean).join(' ');
}

function imwebFeeds(profile) {
  const label = profile === 'default' ? '아임웹' : `아임웹 ${profile.toUpperCase()}`;
  const cli = (...a) => imwebCli('--profile', profile, ...a); // default 도 이름을 붙인다(current_profile 이 바뀌어도 같은 사이트)
  return [{
    name: `imweb.${profile}.order`, mall: label,
    async poll(st, now) {
      // 최신순 목록이다. 직전 확인보다 10분 앞선 주문이 나올 때까지 쪽을 넘긴다(첫 실행은 1쪽).
      // ponytail: 며칠 전 주문의 입금 확인은 목록 뒤로 밀려 있으면 못 잡는다. 최대 10쪽(500건).
      const rows = [];
      for (let p = 1; p <= 10; p++) {
        const page = cli('order', 'list', '--page', String(p), '--limit', '50');
        rows.push(...page);
        if (!st.cursor || page.length < 50 || page.some((x) => Date.parse(x.wtime) < st.cursor - 10 * MINUTE)) break;
      }
      const items = [];
      for (const x of rows.filter((r) => !LINKED.has(r.saleChannel)).reverse()) { // 오래된 것부터
        const ps = (x.payments || []).filter((p) => p.isCancel !== 'Y').map((p) => p.paymentStatus);
        const waiting = ps.includes('PAYMENT_PREPARATION');
        const alive = (x.sections || []).some((s) => !DEAD.has(s.orderSectionStatus));
        if (!alive || (!waiting && !ps.some((s) => PAID.has(s)))) continue; // 입금 전 취소·기한 초과·결제 실패·전액 환불
        items.push({
          id: waiting ? `${x.orderNo}:wait` : String(x.orderNo), // 입금되면 '새 주문'이 한 번 더 온다
          text: lines(`[${label} 새 주문${waiting ? ' · 입금 대기' : ''}] ${x.orderNo}`, dot(x.ordererName, money(x.totalPaymentPrice, x.currency), when(x.wtime)), imwebItems(x.sections || []), imwebWhere(x.sections?.[0])),
        });
      }
      return { items, cursor: now };
    },
  }, {
    // 클레임만 주는 목록은 없다. 섹션 상태(…_REQUEST)로 찾고, 처리되면 목록에서 빠진다.
    name: `imweb.${profile}.claim`, mall: label, open: 'claim',
    async poll() {
      const items = [];
      for (const [s, kind] of [['CANCEL_REQUEST', '취소'], ['RETURN_REQUEST', '반품'], ['EXCHANGE_REQUEST', '교환']]) {
        for (const x of cli('order', 'list', '--order-section-status', s, '--limit', '50').filter((r) => !LINKED.has(r.saleChannel))) {
          for (const sec of (x.sections || []).filter((z) => z.orderSectionStatus === s)) {
            const reason = sec.cancelInfo?.cancelReason || sec.returnInfo?.returnReason || sec.exchangeInfo?.exchangeReason;
            items.push({ id: `${x.orderNo}:${sec.orderSectionCode}:${s}`, text: lines(`[${label} ${kind} 요청] ${x.orderNo}`, dot(x.ordererName, money(x.totalPaymentPrice, x.currency)), imwebItems([sec]), reason && `사유: ${reason}`, imwebWhere(sec)) });
          }
        }
      }
      return { items };
    },
  }, {
    name: `imweb.${profile}.qna`, mall: label, open: 'inquiry',
    async poll() {
      const rows = cli('community', 'qna', 'list', '--limit', '50', '--query', 'status=wait').reverse();
      return { items: rows.map((x) => ({ id: `q${x.qnaNo}`, text: lines(`[${label} 새 문의] ${plain(x.subject)}`, dot(x.nick, when(x.wtime)), plain(x.body).slice(0, 300)) })) };
    },
  }];
}

// ── 돌리기 ─────────────────────────────────────────────────
// poll 은 { items:[{id,text}], cursor?, open? } 를 돌려준다. 다 보내야만 cursor 를 넘기므로, 카톡이 실패하면 다음 회차에 같은 창을 다시 읽는다.
export async function tick({ feeds, state, send, now = Date.now() }) {
  state.feeds ??= {};
  state.sent ??= {};
  for (const f of feeds) {
    const st = (state.feeds[f.name] ??= {});
    let res;
    try {
      res = await f.poll(st, now);
    } catch (e) {
      st.fails = (st.fails || 0) + 1;
      st.error = String(e.stderr || e.message).slice(0, 200);
      console.error(`${f.name} 조회 실패 (${st.fails}회 연속):`, st.error);
      if (st.fails >= FAIL_ALERT && !st.alerted) {
        try {
          await send(`⚠ [${f.mall}] 조회 실패 ${st.fails}회 연속 (${f.name})\n${st.error}`);
          st.alerted = true;
        } catch { /* 다음 회차에 다시 */ }
      }
      continue;
    }
    if (st.alerted) await send(`✅ [${f.mall}] 조회 복구 (${f.name})`).catch(() => {});
    st.fails = 0;
    st.alerted = false;
    if (f.open) st.open = res.open ?? res.items.length;
    if (!st.seen) { // 첫 실행: 지금 보이는 건은 보내지 않는다
      st.seen = [...new Set(res.items.map((i) => i.id))];
      if (res.cursor !== undefined) st.cursor = res.cursor;
      continue;
    }
    const seen = new Set(st.seen); // 같은 회차 안의 중복 id 도 여기서 걸러진다
    let allSent = true;
    for (const it of res.items) {
      if (seen.has(it.id)) continue;
      try {
        await send(it.text);
      } catch (e) {
        console.error('카톡 전송 실패 (다음 회차에 다시 시도):', String(e.stderr || e.message).slice(0, 300));
        allSent = false;
        break;
      }
      seen.add(it.id);
      st.seen.push(it.id);
      state.sent[f.mall] = (state.sent[f.mall] || 0) + 1;
    }
    st.seen = st.seen.slice(-2000);
    if (allSent && res.cursor !== undefined) st.cursor = res.cursor;
  }
}

// 매일 09:00 이후 첫 회차에 한 번. 오지 않으면 워커가 죽은 것이다(생존 신호).
// ponytail: '미답변 문의'는 각 피드의 조회 창(네이버 3일·쿠팡 6일) 안의 개수다.
export function summaryText(feeds, state, now) {
  const malls = [...new Set(feeds.map((f) => f.mall))];
  const body = malls.map((m) => {
    const parts = [['order', '처리 대기 주문'], ['claim', '열린 클레임'], ['inquiry', '미답변 문의']].flatMap(([k, label]) => {
      const fs = feeds.filter((f) => f.mall === m && f.open === k);
      return fs.length ? [`${label} ${fs.reduce((n, f) => n + (state.feeds?.[f.name]?.open ?? 0), 0)}`] : [];
    });
    return `${m}: ${[...parts, `알림 ${state.sent?.[m] || 0}건`].join(' · ')}`;
  });
  const bad = feeds.filter((f) => state.feeds?.[f.name]?.fails).map((f) => f.name);
  return lines(`[베리업 주문 알림 요약] ${kstDate(now)}`, body, `실패 중: ${bad.join(', ') || '없음'}`);
}

async function maybeSummary(feeds, state, send, now) {
  if (new Date(now + H9).getUTCHours() < 9 || state.summaryDay === kstDate(now)) return;
  try {
    await send(summaryText(feeds, state, now));
    state.summaryDay = kstDate(now);
    state.sent = {};
  } catch (e) {
    console.error('요약 전송 실패:', String(e.stderr || e.message).slice(0, 300));
  }
}

function readLogin() {
  const { username, password } = JSON.parse(readFileSync(LOGIN, 'utf8').replace(/^﻿/, ''));
  // setup-login.ps1 이 DPAPI(이 Windows 사용자)로 암호화해 둔 비밀번호를 푼다. 암호문은 stdin 으로 넘긴다.
  const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); '
    + '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
  return { username, password: execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: password, encoding: 'utf8', timeout: 30000 }).trim() };
}

// 서버 쪽 실패는 죽지 않고 '실패 피드'로 남긴다 → 5회 실패 알림·요약에 보이고, 아임웹은 계속 돈다.
async function buildFeeds() {
  const feeds = [];
  let serverDown = false;
  if (existsSync(LOGIN)) {
    // ponytail: 몰 키는 시작할 때 한 번 받는다. 서버에서 키를 바꾸면 워커를 다시 띄운다(로그온마다 다시 뜬다).
    const base = (process.env.ADMIN_SERVER_URL || 'https://admin.veryup-domain.duckdns.org').replace(/\/+$/, '');
    try {
      const { username, password } = readLogin();
      const { token } = await serverLogin(base, username, password);
      for (const [p, mall, make] of [
        ['naver', '네이버', (d) => d.clientId && naverFeeds(new NaverAPI(d))],
        ['coupang', '쿠팡', (d) => d.vendorId && coupangFeeds(new CoupangAPI(d.vendorId, d.accessKey, d.secretKey, d.vendorId, {}), d.vendorId)],
        ['ebay', 'eBay', (d) => d.refreshToken && ebayFeeds(new EbayAPI({ environment: 'production', ...d, scopes: '' }))],
      ]) {
        try {
          const d = (await fetchCredentials(base, token, p)).find((c) => c.data && !c.data.loginId)?.data;
          const made = d && make(d);
          if (made) feeds.push(...made);
          else console.warn(`${p}: 서버에 키가 없어 건너뜀`);
        } catch (e) {
          feeds.push(failing(`${p}.keys`, mall, e));
        }
      }
    } catch (e) {
      serverDown = true;
      feeds.push(failing('server.login', '관리 서버', e));
    }
  } else {
    console.warn(`관리 서버 로그인 정보가 없어 아임웹만 확인합니다 (${LOGIN}). ops/setup-login.ps1 을 한 번 실행하세요.`);
  }
  for (const p of (process.env.OPS_IMWEB_PROFILES || 'default').split(',').map((s) => s.trim()).filter(Boolean)) feeds.push(...imwebFeeds(p));
  return { feeds, serverDown };
}

function loadState(send) {
  if (!existsSync(STATE)) return {};
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch (e) {
    renameSync(STATE, `${STATE}.bad`);
    send(`⚠ 주문 알림 상태 파일이 깨져 새로 시작합니다(이번 회차는 기록만): ${e.message}`).catch(() => {});
    return {};
  }
}

// 한 PC 에서 하나만 돈다. 프로세스가 죽으면 OS 가 파이프를 치운다.
const singleInstance = () => new Promise((ok) => {
  const lock = net.createServer();
  lock.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error('이미 실행 중인 주문 알림 워커가 있어 끝냅니다.');
    process.exit(0);
  });
  lock.listen(String.raw`\\.\pipe\veryup-ops`, () => { lock.unref(); ok(); });
});

async function main() {
  const { values: opt } = parseArgs({
    options: { room: { type: 'string' }, once: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, preview: { type: 'boolean' }, only: { type: 'string' } },
  });
  const room = opt.room || process.env.OPS_ROOM;
  if (!room && !opt['dry-run']) {
    console.error('카톡 방 이름이 필요합니다: --room "방 이름" 또는 veryup.env 의 OPS_ROOM (시험만 하려면 --dry-run)');
    process.exit(1);
  }
  const keeps = !opt['dry-run'] && !opt.preview; // 상태 파일을 쓰는 실행
  if (keeps) await singleInstance();
  const send = async (text) => {
    if (opt['dry-run']) return console.log(`---\n${text}`);
    const file = join(tmpdir(), `veryup-ops-msg.${process.pid}.txt`);
    writeFileSync(file, text);
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'send-kakao.ps1'), '-Room', room, '-TextFile', file],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1000)); // 카톡 연속 전송 간격
  };
  const built = await buildFeeds();
  const feeds = built.feeds.filter((f) => !opt.only || f.name.startsWith(opt.only));
  console.log('피드:', feeds.map((f) => f.name).join(', '));
  // 서버 로그인이 안 됐으면 30분 뒤 끝낸다 → run-ops.bat 루프가 다시 띄우며 재로그인한다.
  if (built.serverDown && keeps && !opt.once) setTimeout(() => process.exit(1), 30 * MINUTE).unref();

  if (opt.preview) {
    for (const f of feeds) {
      try {
        const it = (await f.poll({}, Date.now())).items.at(-1);
        if (it) await send(`--- (베리업 주문 알림 테스트입니다)\n${it.text}`);
      } catch (e) {
        console.error(`${f.name}:`, String(e.stderr || e.message).slice(0, 300));
      }
    }
    return;
  }
  const state = loadState(send);
  for (;;) {
    const now = Date.now();
    await tick({ feeds, state, send, now });
    await maybeSummary(feeds, state, send, now);
    if (keeps) {
      try {
        writeJsonAtomic(STATE, state, 0);
      } catch (e) {
        console.error('상태 저장 실패(다음 회차에 다시 씀):', e.message);
      }
    }
    console.log(new Date().toLocaleTimeString('ko-KR'), '확인 완료');
    if (opt.once) break;
    await new Promise((r) => setTimeout(r, MINUTE));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
