// 좌측 '상품 정보' 에 넣은 값이 쇼핑몰 폼마다 제자리에 똑같이 들어가는지 확인한다.
//
// 셸(index_up.html)을 진짜로 띄우고, 사람이 하듯 좌측 칸에 값을 넣은 뒤 iframe 안 쇼핑몰
// 폼의 칸을 하나씩 읽는다. 버튼은 누르지 않는다 — 좌측 칸이 바뀌면 폼에 곧장 들어가야 한다
// (예전에는 '신규 등록 실행' 을 눌러야 들어갔다). 폼에 값만 넣고 제출하지 않으므로(제출은
// 각 탭의 버튼) 이 검사가 실제 등록을 일으키지 않는다. '입력 확인' 버튼은 경고 로그를 볼
// 때만 누른다(확인: true).
//
// 사전·카테고리는 테스트용 가짜가 아니라 data/ 의 실제 파일을 그대로 먹인다 — 가짜를 쓰면
// '사전에 2세대 전기형이 없어 영문이 비는' 것 같은 실제 문제가 가려진다.
//
// 차는 두 대다. 한 대로는 모든 경로를 못 탄다:
//   · 기아 EV3   — 운영자가 실제로 넣은 화면 그대로(2세대 전기형). 사전에 없는 세대 조합,
//                  DB 표기 그대로 붙여 넣은 상품번호('No.K138번'), BSA O.
//   · 혼다 시빅  — 사전 영문이 전부 대문자(CIVIC)라 대소문자 정리를 탄다. BSA X.
//                  이베이 제목은 판매 중인 리스팅 문구와 글자 그대로 같아야 한다.
// 비어 있던 연식·차량코드·상품번호는 CSV DB 의 해당 차 행에서 가져왔다.
//
// 뒤의 차들은 칸에 치지 않고 좌측 목록에서 '고른다' — 칸에 포커스하면 목록이 열리고, 걸러서,
// 항목을 누른다. 그 한 번에 세대·연식·차량코드·상품번호·SKU·판매가가 같은 행으로 채워지고
// 아마존·이베이까지 가는지 본다. SKU·판매가는 data/vehicle_catalog.json(엑셀 표에서 구운 것).
//
// 끝에 '셸 동작' 을 따로 본다(칸 값이 아니라 흐름): 이베이 수정 비교, 조견표 경고·이베이 이미지 바꿔 끼우기,
// 일괄 등록의 성공·실패 세기·시간 한도·도중 모드 전환 거절·아마존 마켓. 일괄 등록은 몰의 등록 함수를
// 가짜로 바꿔 끼워 정한 결과를 돌려주게 하므로(이베이는 IPC 답을 정해 둔다) 실제 등록은 없다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = JSON.parse(readFileSync(path.join(ROOT, 'data/vehicle_i18n.json'), 'utf-8'));
const categories = JSON.parse(readFileSync(path.join(ROOT, 'data/imweb_categories.json'), 'utf-8'));
const vehicleCatalog = JSON.parse(readFileSync(path.join(ROOT, 'data/vehicle_catalog.json'), 'utf-8'));

const AMZ = 'OGWM Optic-Glass Heated Mirror Glass Replacement Wide Angle View Car Mirror for ';
const AMZ_END = ' Exterior Side View Accessories Left/Right 1 set';
const EBAY = 'Optic-glass Wide Angle View Car Mirror for ';

const 차량들 = [
  {
    이름: '기아 EV3 (운영자 입력 화면 그대로)',
    bsa: 'o',
    입력: {
      'inp-brand': '기아', 'inp-carmodel': 'EV3', 'inp-gen': '2세대 전기형',
      'inp-year': '24.10~', 'inp-code': 'SV', 'inp-no': 'No.K138번',
    },
    // [구역, 칸 id, 무엇, 기대값]
    기대: [
      ['좌측 상품정보', 'inp-brand-en',    '브랜드 영문', 'Kia'],
      ['좌측 상품정보', 'inp-brand-ja',    '브랜드 일문', 'キア'],
      ['좌측 상품정보', 'inp-carmodel-en', '차종 영문',   'EV3'],
      ['좌측 상품정보', 'inp-carmodel-ja', '차종 일문',   'EV3'],
      ['좌측 상품정보', 'inp-gen-en',      '세대 영문',   '2nd gen Early'],   // 사전에 없는 조합
      ['좌측 상품정보', 'inp-gen-ja',      '세대 일문',   '2世代 前期型'],

      ['네이버', 'brand',         '브랜드',        '기아'],
      ['네이버', 'model',         '차종',          'EV3'],
      ['네이버', 'titlePreview',  '상품명',        '옵틱글래스 기아 EV3 광각 사이드 와이드미러'],
      ['네이버', 'optionModel',   '옵션 모델명',   '기아 EV3'],
      ['네이버', 'optionProduct', '옵션 상품선택', '24.10~[No.K138]BSA'],

      ['쿠팡', 'cpBrand',        '브랜드', '기아'],
      ['쿠팡', 'cpModel',        '차종',   'EV3'],
      ['쿠팡', 'cpTitlePreview', '상품명', '옵틱글래스 기아 EV3 광각 사이드 와이드미러'],
      ['쿠팡', 'cpOptModel',     '옵션',   'No.K138번 (2세대 전기형/24.10~) BSA'],

      ['아마존', 'amzBrand', '브랜드',         'Kia'],
      ['아마존', 'amzModel', '차종',           'EV3'],
      ['아마존', 'amzGen',   '세대',           '2nd gen Early'],
      ['아마존', 'amzYear',  '연식',           '24.10~'],
      ['아마존', 'amzCode',  '차량코드',       'SV'],
      // 목록에서 차를 고르지 않고 쳐서 넣었다 → SKU 를 추측하지 않고 비운다(아마존 탭이 막는다).
      ['아마존', 'amzSku',   'SKU (목록 안 고름)', ''],
      ['아마존', 'amzTitle', '상품명',         AMZ + 'Kia EV3 2nd gen Early 24.10~ SV' + AMZ_END],

      ['이베이', 'ebTitle', '상품명', EBAY + 'Kia EV3 2nd gen Early 24.10~ BSA'],

      ['아임웹 B2B', 'iwBrand',      '카테고리 제조사',      '기아'],
      ['아임웹 B2B', 'iwModel',      '카테고리 모델',        'EV3'],
      ['아임웹 B2B', 'iwTitleBrand', '제목 제조사',          '기아'],
      ['아임웹 B2B', 'iwTitleModel', '제목 차종',            'EV3'],
      ['아임웹 B2B', 'iwYear',       '연식',                 '24.10~'],
      ['아임웹 B2B', 'iwCode',       '상품 코드 (상품번호)', 'K138'],
      ['아임웹 B2B', 'iwBsaO',       'BSA O',                true],
      ['아임웹 B2B', 'iwBsaX',       'BSA X',                false],

      ['아임웹 게시판', 'iwBoardBrand',        '게시판 제조사',        '기아'],
      ['아임웹 게시판', 'iwBoardCode',         '상품 코드 (상품번호)', 'K138'],
      ['아임웹 게시판', 'iwBoardTitleBrand',   '한글 제조사',          '기아'],
      ['아임웹 게시판', 'iwBoardTitleModel',   '한글 차종',            'EV3'],
      ['아임웹 게시판', 'iwBoardTitleBrandEn', '영문 제조사',          'Kia'],
      ['아임웹 게시판', 'iwBoardTitleModelEn', '영문 차종',            'EV3'],
      ['아임웹 게시판', 'iwBoardGeneration',   '영문 세대',            '2nd gen Early'],
      ['아임웹 게시판', 'iwBoardTitleBrandJp', '일문 제조사',          'キア'],
      ['아임웹 게시판', 'iwBoardTitleModelJp', '일문 차종',            'EV3'],
      ['아임웹 게시판', 'iwBoardGenerationJp', '일문 세대',            '2世代 前期型'],
      // 셸이 폼 칸에 값을 넣으며 쏜 이벤트를 폼의 자동완성이 사람 입력으로 알고 목록을 열었다
      // (아임웹 제목 칸들) — 좌측에 한 글자 칠 때마다 폼 안에 '일치하는 항목이 없습니다' 가 떴다.
      ['쇼핑몰 폼', 'combos:frame', '폼 안에 저절로 열린 목록', 0],
    ],
  },
  {
    이름: '혼다 시빅 (사전 영문이 전부 대문자 · BSA X)',
    bsa: 'x',
    입력: {
      'inp-brand': '혼다', 'inp-carmodel': '시빅', 'inp-gen': '8세대',
      'inp-year': '06-11', 'inp-code': 'FD', 'inp-no': '1213',
    },
    기대: [
      ['좌측 상품정보', 'inp-brand-en',    '브랜드 영문', 'Honda'],
      ['좌측 상품정보', 'inp-carmodel-en', '차종 영문',   'Civic'],     // 사전: CIVIC
      ['좌측 상품정보', 'inp-gen-en',      '세대 영문',   '8th gen'],   // 사전: 8Gen

      // 판매 중인 리스팅: 'Optic-glass Wide Angle View Car Mirror for Honda Civic 8th gen 06-11'
      ['이베이', 'ebTitle', '상품명', EBAY + 'Honda Civic 8th gen 06-11'],

      ['아마존', 'amzModel', '차종',           'Civic'],
      ['아마존', 'amzSku',   'SKU (목록 안 고름)', ''],
      ['아마존', 'amzTitle', '상품명',         AMZ + 'Honda Civic 8th gen 06-11 FD' + AMZ_END],

      ['네이버', 'optionProduct', '옵션 상품선택', '06-11[No.1213]'],        // BSA 없음
      ['쿠팡',   'cpOptModel',    '옵션',          'No.1213번 (8세대/06-11)'], // BSA 없음

      ['아임웹 B2B', 'iwModel', '카테고리 모델',        '시빅'],
      ['아임웹 B2B', 'iwCode',  '상품 코드 (상품번호)', '1213'],
      ['아임웹 B2B', 'iwBsaO',  'BSA O',                false],
      ['아임웹 B2B', 'iwBsaX',  'BSA X',                true],

      ['아임웹 게시판', 'iwBoardTitleModelEn', '영문 차종', 'Civic'],
      ['아임웹 게시판', 'iwBoardGeneration',   '영문 세대', '8th gen'],
    ],
  },
  {
    이름: 'BMW 1시리즈 — 상품번호 목록에서 2세대를 고름 (BSA X)',
    확인: true,
    bsa: 'x',
    입력: { 'inp-brand': 'BMW', 'inp-carmodel': '1시리즈' },
    고르기: [['inp-no', '101', 'No.101']],
    기대: [
      ['좌측 상품정보', 'inp-gen',  '세대 (행에서)',     '2세대'],
      ['좌측 상품정보', 'inp-year', '연식 (행에서)',     '12.03~19.05'],
      ['좌측 상품정보', 'inp-code', '차량코드 (행에서)', 'F20/F21'],
      ['좌측 상품정보', 'inp-no',   '상품번호 (행에서)', '101'],
      ['좌측 상품정보', 'inp-sku',  'SKU (이베이 표)',   'OBM0103N101'],
      ['좌측 상품정보', 'inp-amz-sku', '아마존 SKU (아마존에 있는 것)', 'OBM0103N101'],
      ['좌측 상품정보', 'inp-usd',  '판매가 (이베이 표)', '109.32'],
      ['좌측 상품정보', 'inp-gen-en',      '세대 영문', '2nd gen'],
      ['좌측 상품정보', 'inp-carmodel-en', '차종 영문', '1 Series'],   // 사전: 1series
      ['좌측 상품정보', 'inp-cpid', '쿠팡 상품ID (쿠팡 표)', '13675654028'],

      // SKU 는 차종마다 다르다 — 같은 No.101 을 쓰는 4시리즈는 OBM0401N101 이다.
      ['아마존', 'amzSku',   'SKU',    'OBM0103N101'],
      ['아마존', 'amzPrice', '판매가', '109.32'],
      ['아마존', 'amzTitle', '상품명', AMZ + 'BMW 1 Series 2nd gen 12.03~19.05 F20/F21' + AMZ_END],
      ['이베이', 'ebSku',    'SKU',    'OBM0103N101'],
      ['이베이', 'ebPrice',  '판매가', '109.32'],
      ['이베이', 'ebTitle',  '상품명', EBAY + 'BMW 1 Series 2nd gen 12.03~19.05'],
      ['쿠팡',   'cpOptModel',    '옵션',          'No.101번 (2세대/12.03~19.05)'],
      ['네이버', 'optionProduct', '옵션 상품선택', '12.03~19.05[No.101]'],
      ['아임웹 B2B', 'iwCode', '상품 코드 (상품번호)', '101'],
      // 이미 쿠팡에 있는 차를 신규로 복사등록하면 같은 차 상품이 둘이 된다 → 경고
      ['셸 로그', 'log:쿠팡에 이미 있는 차입니다 — 상품ID 13675654028', '쿠팡 중복 경고', true],
    ],
  },
  {
    이름: '기아 EV3 — 목록에서 고름 (BSA O: 이베이에 BSA 판만 있다)',
    bsa: 'o',
    입력: { 'inp-brand': '기아', 'inp-carmodel': 'EV3' },
    고르기: [['inp-no', 'K138', 'No.K138']],
    기대: [
      ['좌측 상품정보', 'inp-gen',  '세대 (행에서)',      '1세대'],
      ['좌측 상품정보', 'inp-code', '차량코드 (행에서)',  'SV'],
      ['좌측 상품정보', 'inp-sku',  'SKU (BSA 판)',       'KI1501NK138'],
      ['좌측 상품정보', 'inp-usd',  '판매가 (BSA 판)',    '160.34'],
      ['좌측 상품정보', 'inp-cpid', '쿠팡 상품ID',        '15628106868'],
    ],
  },
  {
    이름: '└ 이어서 BSA X 로 바꿈 — BSA 없는 판은 표에 없다',
    bsa: 'x', bsa바꿈: true,   // change 를 쏜다 = 사람이 라디오를 누른 것
    기대: [
      // 앞 차의 BSA 판 SKU 가 남아 있으면 BSA 없는 상품이 BSA SKU 로 올라간다 → 비워야 한다.
      ['좌측 상품정보', 'inp-sku', 'SKU (비움)',    ''],
      ['좌측 상품정보', 'inp-usd', '판매가 (비움)', ''],
    ],
  },
  {
    이름: '└ 이어서 SKU 목록에서 BSA 판을 고름 — BSA 라디오가 따라온다',
    고르기: [['inp-sku', '', 'KI1501NK138']],
    기대: [
      ['좌측 상품정보', 'inp-sku', 'SKU (고름)',          'KI1501NK138'],
      ['좌측 상품정보', 'inp-usd', '판매가 (SKU 를 따름)', '160.34'],
      ['좌측 상품정보', 'bsa-o',   'BSA O 로 바뀜',        true],
    ],
  },
  {
    이름: '└ 상품번호를 101 로 바꾸고 SKU 는 EV3 것을 그대로 둠 — 입력 확인이 경고해야 한다',
    확인: true,
    입력: { 'inp-brand': 'BMW', 'inp-carmodel': '1시리즈', 'inp-no': '101', 'inp-sku': 'KI1501NK138' },
    기대: [
      // 그대로 올리면 BMW 1시리즈가 EV3 리스팅(KI1501NK138)을 덮어쓴다.
      ['셸 로그', 'log:SKU KI1501NK138 는 상품번호 101 의 것이 아닙니다', 'SKU 불일치 경고', true],
      // 상품번호를 손으로 바꿨으니 EV3 로 채웠던 쿠팡 상품ID 는 비워져야 한다.
      ['좌측 상품정보', 'inp-cpid', '쿠팡 상품ID (비움)', ''],
    ],
  },
  {
    이름: 'BMW 1시리즈를 다시 고름 — 쇼핑몰별 칸 · 이베이 제목 자동완성',
    bsa: 'x', bsa바꿈: true,
    입력: { 'inp-sku': '' },   // 앞 경우에서 손으로 넣은 EV3 SKU 를 비워야 다시 자동으로 찬다
    고르기: [['inp-no', '101', 'No.101']],
    기대: [
      ['좌측 상품정보', 'inp-sku', 'SKU (이베이 표)', 'OBM0103N101'],
      // 쇼핑몰별 칸: 켜진 몰이 쓰는 칸만 보인다(아마존·이베이·쿠팡 모두 켜져 있다).
      ['좌측 상품정보', 'shown:inp-sku',       'SKU 칸 보임',          true],
      ['좌측 상품정보', 'shown:inp-amz-ptype', 'Product Type 칸 보임', true],
      ['좌측 상품정보', 'shown:inp-cpid',      '쿠팡 상품ID 칸 보임',  true],
      ['좌측 상품정보', 'tags:inp-sku',        '이베이 SKU 칸 꼬리표', ' · 이베이'],
      ['좌측 상품정보', 'shown:inp-amz-sku',   '아마존 SKU 칸 보임',   true],
      ['좌측 상품정보', 'tags:inp-amz-sku',    '아마존 SKU 칸 꼬리표', ' · 아마존'],
      // 탭 안의 같은 칸은 숨었다 — 좌측이 대신한다.
      ['쇼핑몰 폼', 'owned:ebSku',          '이베이 SKU 칸 숨김',        true],
      ['쇼핑몰 폼', 'owned:amzProductType', '아마존 Product Type 칸 숨김', true],
      ['쇼핑몰 폼', 'owned:iwTargetHead',   '게시판 대상 체크 숨김(현황판이 대신)', true],
      ['아마존', 'amzProductType', 'Product Type (좌측에서)', 'AUTO_PART'],
      ['이베이', 'ebSku',   'SKU',    'OBM0103N101'],
      ['이베이', 'ebTitle', '상품명', EBAY + 'BMW 1 Series 2nd gen 12.03~19.05'],
      // 자동완성 목록: 상품 정보로 만든 제목 + 이베이 표에 적힌 그 SKU 의 표기로 만든 제목
      ['이베이', 'list:ebTitle', '제목 목록 — 상품 정보', /BMW 1 Series 2nd gen 12\.03~19\.05 · 75자 · 상품 정보/],
      ['이베이', 'list:ebTitle', '제목 목록 — 이베이 표', /BMW 1 Series 2nd gen · 63자 · 이베이 표 OBM0103N101/],
    ],
  },
  {
    이름: '탭에서 고친 칸은 좌측의 다른 칸을 바꿔도 남는다',
    탭에서치기: [['naverTab', 'KOREA', 'optionProduct', '수동으로 고친 옵션']],
    입력: { 'inp-code': 'F20' },   // 네이버 옵션(연식[No.번호])과 상관없는 칸
    확인: true,
    기대: [
      ['네이버', 'optionProduct', '탭에서 고친 값 유지', '수동으로 고친 옵션'],
      ['아마존', 'amzCode',       '다른 칸은 좌측을 따름', 'F20'],
      ['셸 로그', 'log:탭에서 직접 고친 칸은 그대로 뒀습니다', '그대로 둔 칸 알림', true],
    ],
  },
  {
    이름: '└ 그 칸을 만드는 좌측 연식을 바꾸면 다시 좌측 값으로',
    입력: { 'inp-year': '12.03~19' },
    기대: [
      ['네이버', 'optionProduct', '좌측 값으로 돌아옴', '12.03~19[No.101]'],
    ],
  },
  {
    이름: '아마존 제목을 탭에서 고치면 제목과 상관없는 좌측 칸을 쳐도 남는다',
    // 예전: 채우기마다 탭의 마켓 동기화를 불러 제목을 다시 만들었다 — 좌측 아무 칸이나 치면 되돌아갔다.
    탭에서치기: [['amazonTab', 'USA', 'amzTitle', 'MY OWN AMAZON TITLE']],
    입력: { 'inp-gen-ja': '2代目' },   // 미국 아마존 제목에는 안 쓰이는 칸
    기대: [
      ['아마존', 'amzTitle', '탭에서 고친 제목 유지', 'MY OWN AMAZON TITLE'],
    ],
  },
  {
    이름: '└ 제목을 만드는 좌측 칸(차량코드)을 바꾸면 자동 제목으로',
    입력: { 'inp-code': 'F21' },
    기대: [
      ['아마존', 'amzTitle', '자동 제목', AMZ + 'BMW 1 Series 2nd gen 12.03~19 F21' + AMZ_END],
    ],
  },
  {
    이름: '└ 차량코드를 되돌림',
    입력: { 'inp-code': 'F20' },
    기대: [
      ['아마존', 'amzTitle', '자동 제목', AMZ + 'BMW 1 Series 2nd gen 12.03~19 F20' + AMZ_END],
    ],
  },
  {
    이름: '아마존 일본까지 켬 — 아마존 탭은 마지막으로 누른 나라 마켓',
    켜기: [['JAPAN', 'open1', true]],
    기대: [
      ['아마존', 'amzMarketplaceId', '마켓 (일본)', 'A1VC38T7YXB528'],
      ['아마존', 'amzCurrency',      '통화',        'JPY'],
    ],
  },
  {
    이름: '└ 켜져 있는 미국 아마존 칸을 누름 — 끄지 않고 미국 마켓으로 바꾼다',
    누르기: [['USA', 'open1']],
    확인: true,
    기대: [
      ['현황판', 'on:USA.open1', '미국 아마존 켜진 채', true],
      ['아마존', 'amzMarketplaceId', '마켓 (미국)', 'ATVPDKIKX0DER'],
      ['아마존', 'amzCurrency',      '통화',        'USD'],
      ['아마존', 'amzTitle', '상품명', AMZ + 'BMW 1 Series 2nd gen 12.03~19 F20' + AMZ_END],
      // 예전에는 일본이 켜져 있으면 무조건 일본이라 미국에는 한 건도 안 갔다.
      ['셸 로그', 'log:아마존 미국·일본을 둘 다 켰습니다', '한 번에 한 마켓 경고', true],
    ],
  },
  {
    이름: '└ 일본 아마존과 쿠팡을 끔 — 그 몰만 쓰는 칸이 사라진다',
    켜기: [['JAPAN', 'open1', false], ['KOREA', 'open2', false]],
    기대: [
      ['좌측 상품정보', 'shown:inp-cpid',      '쿠팡 상품ID 칸 숨음',                 false],
      ['좌측 상품정보', 'shown:inp-amz-ptype', 'Product Type 칸은 남음 (미국 아마존)', true],
    ],
  },
  {
    이름: '└ 쿠팡을 다시 켬',
    켜기: [['KOREA', 'open2', true]],
    기대: [
      ['좌측 상품정보', 'shown:inp-cpid', '쿠팡 상품ID 칸 보임', true],
    ],
  },
  {
    이름: '상품번호를 번호 모양이 아니게 치면 입력 확인이 알린다',
    // 번호를 못 읽으면 적힌 글이 제목·옵션에 그대로 들어가고 SKU·쿠팡 중복 확인은 조용히 빠진다.
    입력: { 'inp-no': '옵션' },
    확인: true,
    기대: [
      ['셸 로그', 'log:상품번호 "옵션" 를 읽지 못했습니다', '못 읽은 번호 알림', true],
    ],
  },
  {
    이름: '수정 모드 — 차를 고르면 쿠팡 탭 "수정할 상품 ID" 로 넘어간다',
    수정모드: true,
    bsa: 'o',   // 수정 모드에선 BSA 칸이 숨고 마크업 기본값(O)인 채로 남는다 — 그 상태 그대로
    입력: { 'inp-brand': '혼다', 'inp-carmodel': '시빅', 'inp-no': '' },
    고르기: [['inp-no', '1213', 'No.1213']],
    기대: [
      ['좌측 상품정보', 'inp-cpid',         '쿠팡 상품ID',      '13675461669'],
      // 예전엔 쿠팡 탭에서 제조사·차종을 다시 치고 찾아야 했다.
      ['쿠팡',          'cpProductIdInput', '수정할 상품 ID',   '13675461669'],
      // 수정 모드에선 BSA 칸이 숨어 있다. 보이지 않는 BSA 기본값(O)으로 SKU 를 거르면 BSA 없는
      // 시빅의 SKU 가 안 찼다 — 이어진 SKU 가 하나뿐이면 그걸 쓴다.
      ['좌측 상품정보', 'inp-sku',          'SKU',              'NH0701N1213'],
      ['아마존',        'amzSku',           'SKU 기준 불러오기 칸', 'NH0701N1213'],
      ['이베이',        'ebEditSku',        'SKU 조회 칸',      'NH0701N1213'],
      ['아임웹 게시판', 'iwBoardEditCodeInput', '검색할 상품 코드', '1213'],
      ['아임웹 게시판', 'iwBoardEditBrand',     '검색 브랜드',      '혼다'],
      // 수정 폼의 나머지는 불러온 상품의 값이다 — 좌측 차로 덮으면 안 된다.
      ['아마존',        'amzTitle',         '상품명 (건드리지 않음)', AMZ + 'BMW 1 Series 2nd gen 12.03~19 F20' + AMZ_END],
    ],
  },
  {
    이름: '└ 탭에서 검색 결과로 고른 상품은 좌측 다른 칸을 쳐도 남는다',
    // 이베이 '목록에서 선택' · 아마존 검색 결과 선택 · 쿠팡 'ID 찾기' 는 탭 스크립트가 칸을 바꾼다
    // (사람 입력 표시가 안 붙는다). 좌측 아무 칸이나 칠 때마다 좌측 SKU 로 되돌아가면 안 된다.
    탭스크립트: [['ebEditSku', 'PICKED-EBAY'], ['amzSku', 'PICKED-AMZ'], ['cpProductIdInput', '99999']],
    입력: { 'inp-code': 'FD2' },
    기대: [
      ['이베이', 'ebEditSku',        '탭에서 고른 SKU 유지', 'PICKED-EBAY'],
      ['아마존', 'amzSku',           '탭에서 고른 SKU 유지', 'PICKED-AMZ'],
      ['쿠팡',   'cpProductIdInput', '탭에서 고른 ID 유지',  '99999'],
    ],
  },
  {
    이름: '└ 쿠팡·아마존에서 상품 A 를 불러온 뒤 좌측에서 차 B 를 고름 — 저장을 거부한다',
    // 예전: 저장이 입력칸의 ID·SKU 로 나가서 A 를 불러와 고친 제목·옵션·이미지가 B 상품에 덮였다.
    탭스크립트: [['cpProductIdInput', '13675461669'], ['amzSku', 'NH0701N1213']],
    먼저: 'Promise.all([loadCoupangProduct(), loadAmazonProduct()])',   // 탭의 '불러오기' 버튼
    입력: { 'inp-brand': 'BMW', 'inp-carmodel': '1시리즈', 'inp-no': '' },
    고르기: [['inp-no', '101', 'No.101']],
    탭호출: ['saveCoupangEdit', 'registerAmazon'],
    기대: [
      ['쿠팡',   'cpProductIdInput', '좌측이 바뀌어 새 차 ID',  '13675654028'],
      ['아마존', 'amzSku',           '좌측이 바뀌어 새 차 SKU', 'OBM0103N101'],
      ['쿠팡',   'calls:coupang-update', '쿠팡 수정 요청 안 나감',   0],
      ['아마존', 'calls:amazon-update',  '아마존 수정 요청 안 나감', 0],
      ['셸 로그', 'log:불러온 상품(ID 13675461669)과 입력칸의 ID(13675654028)가 다릅니다', '쿠팡 거부 알림',   true],
      ['셸 로그', 'log:불러온 상품(SKU NH0701N1213)과 지금 SKU 칸(OBM0103N101)',          '아마존 거부 알림', true],
    ],
  },
  {
    이름: '└ 입력칸을 불러온 그 상품으로 되돌리면 저장한다',
    탭스크립트: [['cpProductIdInput', '13675461669'], ['amzSku', 'NH0701N1213']],
    탭호출: ['saveCoupangEdit', 'registerAmazon'],
    기대: [
      ['쿠팡',   'calls:coupang-update', '쿠팡 수정 요청 나감',   1],
      ['아마존', 'calls:amazon-update',  '아마존 수정 요청 나감', 1],
    ],
  },
  {
    이름: '└ 신규 모드에 갔다가 돌아옴 — 탭이 비운 쿠팡 ID 칸을 좌측 차로 다시 채운다',
    // 쿠팡 탭은 모드를 바꿀 때 이 칸을 스스로 고쳐 쓴다(신규: 템플릿 ID, 수정: 빈칸).
    모드: ['new', 'edit'],
    기대: [
      ['쿠팡', 'cpProductIdInput', '좌측 차의 ID', '13675654028'],
    ],
  },
  {
    이름: '└ 아마존: 신규 모드를 다녀오면 폼에 신규 등록 값이 들어 있다 — 다시 불러오기 전엔 수정 저장을 거부',
    // 신규·수정 폼이 같은 칸을 쓴다. 예전에는 '불러온 상품' 표시가 남아 신규 값이 그 SKU 로 저장됐다.
    탭스크립트: [['amzSku', 'NH0701N1213']],
    탭호출: ['registerAmazon'],
    기대: [
      ['아마존', 'calls:amazon-update', '아마존 수정 요청 (앞의 1건 그대로)', 1],
      ['셸 로그', 'log:수정할 상품(SKU NH0701N1213)을 먼저 불러오세요', '다시 불러오라는 알림', true],
    ],
  },
  {
    이름: '└ 이베이: 조회가 도는 사이 좌측 SKU 가 바뀜 — 조회한 상품에 수정·중단 버튼이 열리지 않는다',
    // 조회 중엔 셸이 칸을 안 바꾸고, 끝나면 좌측 SKU 로 바꾼다 → 불러온 상품은 버려진다.
    탭스크립트: [['ebEditSku', 'EB-A']],
    먼저: "document.querySelector('[data-eb=\"load\"]').click()",
    입력: { 'inp-sku': 'EB-B' },
    기다림: 900,
    기대: [
      ['이베이', 'ebEditSku',        'SKU 칸 = 좌측 SKU',     'EB-B'],
      ['이베이', 'disabled:ebUpdate',   '수정 버튼 잠김',     true],
      ['이베이', 'disabled:ebWithdraw', '판매 중단 버튼 잠김', true],
    ],
  },
  {
    // 이베이 표와 아마존 표가 같은 차에 SKU 를 다르게 매겼다. 예전에는 SKU 칸이 하나라 한쪽 몰에 틀린 SKU 가 갔다.
    이름: '같은 차에 이베이·아마존 SKU 가 다름(3시리즈 6세대) — 칸이 몰마다 따로 채워지고 각 탭으로 간다',
    입력: { 'inp-brand': 'BMW', 'inp-carmodel': '3시리즈', 'inp-no': '' },
    고르기: [['inp-no', '101', 'No.101']],
    기대: [
      ['좌측 상품정보', 'inp-sku',     '이베이 SKU (이베이 표)',        'OBM0305N101'],
      ['좌측 상품정보', 'inp-amz-sku', '아마존 SKU (아마존에 있는 것)', 'OBM0304N101'],
      ['아마존', 'amzSku',    'SKU 기준 불러오기 칸', 'OBM0304N101'],
      ['이베이', 'ebEditSku', 'SKU 조회 칸',          'OBM0305N101'],
    ],
  },
  {
    // 자동완성은 표(엑셀) 값보다 앱이 API 로 받아 둔 지금 몰 값을 먼저 보인다(main 'vehicle-live-values').
    이름: '└ 지금 몰 판매가(API 로 받아 둔 값)가 SKU·변경 판매가 목록에 보인다',
    켜기: [['JAPAN', 'open1', true]],   // 변경 판매가(엔) 칸은 아마존 일본을 켜야 보인다
    셸: `(async () => {
      window.__script = window.__script || {};
      window.__script['vehicle-live-values'] = { success: true, live: {
        amazon: { US: { items: { OBM0304N101: { price: '110', stock: '999' } } }, JP: { items: { OBM0304N101: { price: '17000', stock: '5' } } } },
        ebay: { items: { OBM0305N101: { price: '111', stock: '3' } } }, coupang: { items: {} } } };
      await loadLiveValues({ force: true });
    })()`,
    기대: [
      ['좌측 상품정보', 'shelllist:inp-amz-sku', '아마존 SKU 목록 — 지금 판매가·재고', /OBM0304N101 · .*\$110\.00 지금 아마존 · 재고 999/],
      ['좌측 상품정보', 'shelllist:inp-sku',     '이베이 SKU 목록 — 지금 판매가·재고', /OBM0305N101 · .*\$111\.00 지금 eBay · 재고 3/],
      ['좌측 상품정보', 'shelllist:inp-edit-usd', '변경 판매가(USD) 목록 맨 위', /^110 USD · 지금 아마존 판매가 \(OBM0304N101\) \| 111 USD · 지금 eBay 판매가 \(OBM0305N101\)(?!.*11[01]\.00 USD)/],
      ['좌측 상품정보', 'shelllist:inp-edit-jpy', '변경 판매가(엔) 목록 맨 위', /^17,000엔 · 지금 아마존 일본 판매가 \(OBM0304N101\)/],
    ],
  },
  {
    이름: '└ 아마존 일본을 다시 끔(뒤의 셸 동작 검사는 미국만 켠 상태를 쓴다)',
    켜기: [['JAPAN', 'open1', false]],
    기대: [['현황판', 'on:JAPAN.open1', '아마존 일본 꺼짐', false]],
  },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  // file:// 문서는 출처가 'null' 이라 크롬은 셸이 iframe 안을 못 읽게 막는다.
  // 앱(Electron)은 이 제한이 없으므로, 같은 조건을 맞추려고 푼다.
  args: ['--allow-file-access-from-files'],
});

try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  // electron 흉내. 사전·카테고리 두 채널만 실제 데이터를 돌려주고 나머지는 빈 응답이다.
  // addInitScript 는 iframe 에도 똑같이 들어간다 — 쇼핑몰 폼(index.html)도 require 를 쓴다.
  await context.addInitScript(({ names, categories, vehicleCatalog }) => {
    // 메인 프로세스가 보내는 알림(veryup-set-mode 등)을 검사가 직접 쏠 수 있게 듣는 쪽을 모아 둔다.
    const listeners = window.__listeners = {};
    const ipcRenderer = {
      on(channel, fn) { (listeners[channel] = listeners[channel] || []).push(fn); },
      send(channel, arg) { (window.__sent = window.__sent || []).push([channel, arg]); },
      removeListener() {},
      invoke(channel, arg) {
        (window.__calls = window.__calls || []).push(channel);   // 수정 저장이 나갔는지 본다
        (window.__callArgs = window.__callArgs || []).push([channel, arg]);
        // 검사가 채널마다 정해 둔 답(값, 또는 arg => 값)이 있으면 그걸 준다 — 아래 기본 답보다 먼저.
        const scripted = window.__script && window.__script[channel];
        if (scripted !== undefined) return Promise.resolve(typeof scripted === 'function' ? scripted(arg) : scripted);
        // 수정 모드 '불러오기' — 실제 탭 함수(loadCoupangProduct·loadAmazonProduct·이베이 조회)를 태운다.
        if (channel === 'coupang-load-product') {
          return Promise.resolve({ success: true, product: { productId: Number(arg), title: `불러온 ${arg}`, options: [], detailImages: [] } });
        }
        if (channel === 'amazon-load-product') {
          return Promise.resolve({ success: true, product: { title: `Loaded ${arg.sku}`, price: '1', stock: '1', brand: 'B',
            mainImageUrl: '', description: '', bulletPoints: [], asin: 'A1', status: 'BUYABLE' } });
        }
        if (channel === 'ebay-load-product') {   // 늦게 온다 — 그 사이 좌측이 바뀌는 경우를 본다
          return new Promise(r => setTimeout(() => r({ success: true, data: {
            sku: arg, offer: { status: 'PUBLISHED', offerId: 'O1', pricingSummary: { price: { value: '1' } }, availableQuantity: 1, listing: { listingId: 'L1' } },
            inventory: { product: { title: `eBay ${arg}` }, availability: {} } } }), 500));
        }
        if (channel === 'vehicle-load-i18n') return Promise.resolve({ success: true, names });
        if (channel === 'imweb-load-categories') return Promise.resolve({ success: true, categories });
        if (channel === 'vehicle-load-catalog') return Promise.resolve({ success: true, catalog: vehicleCatalog });
        return Promise.resolve({});
      },
    };
    window.require = () => ({ ipcRenderer, shell: {} });
  }, { names, categories, vehicleCatalog });

  const page = await context.newPage();
  // 신규 등록 폼은 좌측이 채우는 칸을 숨긴다(vu-new — embedded-platform.css .shell-fed). '탭에서 고친 칸은
  // 덮지 않는다' 규칙은 그대로라서, 사람이 칠 동안만 숨김을 풀어 그 규칙을 본다.
  const 숨김풀고 = async fn => {
    const 숨김 = on => page.evaluate(on => document.getElementById('form-frame').contentDocument.documentElement.classList.toggle('vu-new', on), on);
    await 숨김(false);
    try { await fn(); } finally { await 숨김(true); }
  };
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  // 일괄 등록은 입력 확인 경고가 있으면 confirm 으로 묻는다. 기본은 '계속' — 취소 검사에서만 거절한다.
  let 확인답 = true;
  page.on('dialog', d => (확인답 ? d.accept() : d.dismiss()));
  await page.goto(pathToFileURL(path.join(ROOT, 'src/ui/index_up.html')).href);

  // 사전이 도착해야 영문·일문 자동 채움이 돈다.
  await page.waitForFunction(() => window.VUSuggest?.brandEn?.('기아') === 'Kia', null, { timeout: 15000 });
  await page.waitForFunction(() => (window.VUSuggest?.variantsFor?.('BMW', '1시리즈') || []).length > 0, null, { timeout: 15000 });

  // 쇼핑몰을 모두 켠다. 일본은 자사몰만 — 일본 아마존을 켜면 아마존이 일본어로 바뀌어
  // 미국 아마존 제목을 검사할 수 없다(그 경로는 따로 봐야 한다).
  await page.evaluate(() => {
    for (const [c, t] of [['KOREA', 'own'], ['KOREA', 'b2b'], ['KOREA', 'open1'], ['KOREA', 'open2'],
                          ['USA', 'open1'], ['USA', 'open2'], ['JAPAN', 'own']]) {
      handleCheck(c, t, true);
    }
  });

  // 쇼핑몰 폼(iframe)이 다 뜰 때까지. 이베이 탭은 ebay.js 가 나중에 붙인다.
  await page.waitForFunction(() => {
    const f = document.getElementById('form-frame');
    const w = f?.contentWindow, d = w?.document;
    return d?.readyState === 'complete' && d.querySelector('.tab-btn')
        && d.getElementById('amzSku') && typeof w.ebayImportCommon === 'function';
  }, null, { timeout: 20000 });

  const 틀림 = [];
  let 전체 = 0;

  for (const 차 of 차량들) {
    console.log(`\n════ ${차.이름}`);

    if (차.수정모드) {
      await page.evaluate(() => {
        const r = document.getElementById('mode-edit');
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        openPlatformTab('coupangTab', 'KOREA');
      });
      await page.waitForFunction(() => {
        const d = document.getElementById('form-frame').contentWindow.document;
        return d.querySelector('input[name="cpWorkMode"]')?.value === 'edit';
      }, null, { timeout: 10000 });
    }

    // 모드 라디오를 눌러 오간다. 모드마다 탭이 칸을 다시 그리고, 채우기가 한 번 돈다.
    for (const m of 차.모드 || []) {
      await page.evaluate(m => {
        const r = document.getElementById(m === 'edit' ? 'mode-edit' : 'mode-new');
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }, m);
      await page.waitForFunction(m => {
        const d = document.getElementById('form-frame').contentWindow.document;
        return d.querySelector('input[name="cpWorkMode"]')?.value === (m === 'edit' ? 'edit' : 'copy');
      }, m, { timeout: 10000 });
      await page.waitForFunction(() => frameSyncTimer === null, null, { timeout: 5000 });
    }

    // 현황판 켜고 끄기 / 이미 켜진 칸 누르기
    for (const [c, t, on] of 차.켜기 || []) {
      await page.evaluate(([c, t, on]) => handleCheck(c, t, on), [c, t, on]);
    }
    for (const [c, t] of 차.누르기 || []) {
      await page.evaluate(([c, t]) => document.getElementById(`cell-${c}-${t}`).closest('td').click(), [c, t]);
    }
    // 탭 스크립트가 칸을 바꾼다(검색 결과 선택처럼) — 이벤트 없이 값만.
    for (const [id, value] of 차.탭스크립트 || []) {
      await page.evaluate(([id, value]) => {
        document.getElementById('form-frame').contentWindow.document.getElementById(id).value = value;
      }, [id, value]);
    }
    // 탭의 버튼이 부르는 함수를 좌측을 바꾸기 전에 먼저 부른다(불러오기 등). 가짜 IPC 가 상품을 돌려준다.
    if (차.먼저) {
      await page.evaluate(code => document.getElementById('form-frame').contentWindow.eval(code), 차.먼저);
    }
    // 셸에서 먼저 돌릴 것(가짜 IPC 응답을 정하고 그걸 읽게 하는 등). 끝날 때까지 기다린다.
    if (차.셸) await page.evaluate(code => (0, eval)(code), 차.셸);
    // 탭 칸을 사람이 직접 고친다 — 진짜 키 입력이어야 한다(프로그램이 쏜 이벤트와 구분된다).
    for (const [tab, country, id, value] of 차.탭에서치기 || []) {
      await page.evaluate(([tab, country]) => openPlatformTab(tab, country), [tab, country]);
      await 숨김풀고(() => page.frameLocator('#form-frame').locator('#' + id).fill(value));
    }

    if (차.bsa) {
      await page.evaluate(([v, fire]) => {
        const r = document.querySelector(`input[name="bsa"][value="${v}"]`);
        r.checked = true;
        if (fire) r.dispatchEvent(new Event('change', { bubbles: true }));
      }, [차.bsa, !!차.bsa바꿈]);
    }

    // 사람이 치듯 input 이벤트를 쏜다 — 영문·일문 자동 채움은 이 이벤트에 걸려 있다.
    for (const [id, value] of Object.entries(차.입력 || {})) {
      await page.evaluate(([id, value]) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [id, value]);
    }

    // 목록에서 고르기: 포커스하면 목록이 열리고, 걸러 쓰고, 보이는 글로 항목을 찾아 누른다.
    for (const [id, filter, text] of 차.고르기 || []) {
      const shown = await page.evaluate(([id, filter, text]) => {
        const el = document.getElementById(id);
        el.focus();
        el.value = filter;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const rows = [...document.querySelectorAll('.vu-combo-item')];
        const row = rows.find(r => r.textContent.includes(text));
        if (!row) return rows.map(r => r.textContent).slice(0, 8);
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.blur();
        return null;
      }, [id, filter, text]);
      if (shown) throw new Error(`[${차.이름}] ${id} 목록에 "${text}" 가 없다. 보이는 것: ${JSON.stringify(shown)}`);
    }

    // 버튼 없이 들어가야 한다 — 좌측 칸이 바뀌고 잠깐(모아서 한 번에 넣는 틈) 뒤면 끝나 있다.
    await page.waitForFunction(() => frameSyncTimer === null, null, { timeout: 5000 });
    if (차.확인) await page.evaluate(() => runRegister());
    // 탭의 저장 버튼이 부르는 함수를 그대로 부른다.
    for (const fn of 차.탭호출 || []) {
      await page.evaluate(fn => document.getElementById('form-frame').contentWindow[fn](), fn);
    }
    // 늦게 오는 응답을 기다린다. 그 뒤 탭이 부른 채우기도 끝나야 한다.
    if (차.기다림) {
      await page.waitForTimeout(차.기다림);
      await page.waitForFunction(() => frameSyncTimer === null, null, { timeout: 5000 });
    }

    const 실제 = await page.evaluate(ids => {
      const doc = document.getElementById('form-frame').contentWindow.document;
      const out = {};
      for (const id of ids) {
        if (id === 'bsa-o') { out[id] = document.querySelector('input[name="bsa"][value="o"]').checked; continue; }
        if (id.startsWith('log:')) { out[id] = document.getElementById('log-window').textContent.includes(id.slice(4)); continue; }
        if (id.startsWith('calls:')) { out[id] = (doc.defaultView.__calls || []).filter(c => c === id.slice(6)).length; continue; }
        if (id === 'combos:frame') { out[id] = doc.querySelectorAll('.vu-combo').length; continue; }
        if (id.startsWith('disabled:')) { out[id] = !!doc.getElementById(id.slice(9))?.disabled; continue; }
        if (id.startsWith('on:')) { const [c, t] = id.slice(3).split('.'); out[id] = checked[c][t]; continue; }
        if (id.startsWith('shown:')) { out[id] = !document.getElementById(id.slice(6)).closest('.mall-field').hidden; continue; }
        if (id.startsWith('tags:')) { out[id] = document.getElementById(id.slice(5)).closest('.mall-field').querySelector('.mall-tags').textContent; continue; }
        if (id.startsWith('owned:')) {
          const box = doc.getElementById(id.slice(6))?.closest('.shell-owned');
          out[id] = !!box && doc.defaultView.getComputedStyle(box).display === 'none';
          continue;
        }
        if (id.startsWith('shelllist:')) {   // 좌측 칸의 자동완성 목록
          const el = document.getElementById(id.slice(10));
          el.focus();
          out[id] = [...document.querySelectorAll('.vu-combo-item')].map(r => r.textContent).join(' | ');
          el.blur();
          continue;
        }
        if (id.startsWith('list:')) {
          // 탭의 칸에 포커스하면 목록이 열린다. 보이는 글을 모아 두고 닫는다.
          // 숨은 탭의 칸은 포커스가 안 가므로 그 칸의 탭을 먼저 연다.
          const el = doc.getElementById(id.slice(5));
          openPlatformTab(el.closest('.tab-pane').id, 'USA');
          el.focus();
          out[id] = [...doc.querySelectorAll('.vu-combo-item')].map(r => r.textContent).join(' | ');
          el.blur();
          continue;
        }
        const el = document.getElementById(id) || doc.getElementById(id);
        out[id] = !el ? '(칸 없음)' : (el.type === 'checkbox' ? el.checked : el.value);
      }
      return out;
    }, 차.기대.map(r => r[1]));

    // 어긋난 칸은 전부 모아서 한 번에 실패시킨다(첫 칸에서 멈추면 나머지를 모른다).
    let 구역 = '';
    for (const [where, id, what, want] of 차.기대) {
      const got = 실제[id];
      const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
      전체 += 1;
      if (where !== 구역) { console.log(`── ${where}`); 구역 = where; }
      console.log(`  ${ok ? 'OK' : 'XX'}  ${what.padEnd(14)} ${JSON.stringify(got)}${ok ? '' : `   ← 기대 ${JSON.stringify(want)}`}`);
      if (!ok) 틀림.push(`[${차.이름}] ${where} · ${what} (${id}): ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 셸 동작 — 칸 값이 아니라 버튼·흐름을 본다. 위 경우들이 끝난 상태(수정 모드)에서 이어 간다.
  //   · 이베이 수정: Listing ID·다른 대소문자로 불러온 상품도 수정되고, 칸이 바뀌면 거부
  //   · 조견표: 다른 차로 불러온 조견표 경고 · 이베이 이미지는 바꿔 끼우고(누적 X) 사람이 넣은 건 남김
  //   · 일괄 등록: 몰마다 받은 결과대로 세고(성공만 성공), 도중 모드 전환 거절, 아마존은 채운 마켓만
  // 등록 함수는 가짜로 바꿔 끼운다(실제 요청 없음). 이베이만 진짜 ebayDraft 를 태우고 IPC 답을 정해 준다.
  // ════════════════════════════════════════════════════════════════
  const 판정 = (이름, rows) => {
    console.log(`\n════ ${이름}`);
    let 구역 = '';
    for (const [where, what, got, want] of rows) {
      const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
      전체 += 1;
      if (where !== 구역) { console.log(`── ${where}`); 구역 = where; }
      console.log(`  ${ok ? 'OK' : 'XX'}  ${what.padEnd(14)} ${JSON.stringify(got)}${ok ? '' : `   ← 기대 ${JSON.stringify(want)}`}`);
      if (!ok) 틀림.push(`[${이름}] ${where} · ${what}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    }
  };
  const 폼 = page.frames().find(f => f.url().includes('/index.html'));
  const 로그 = () => page.evaluate(() => document.getElementById('log-window').textContent);
  const 로그비우기 = () => page.evaluate(() => { document.getElementById('log-window').innerHTML = ''; });
  const 채우기끝 = () => page.waitForFunction(() => frameSyncTimer === null, null, { timeout: 5000 });
  const 이베이끝 = () => 폼.waitForFunction(() => !window.ebayBusy(), null, { timeout: 5000 });
  const 이베이로그 = () => 폼.evaluate(() => document.getElementById('ebLog').textContent);
  const 이베이이미지 = () => 폼.evaluate(() => document.getElementById('ebImages').value);
  const 호출수 = channel => 폼.evaluate(c => (window.__calls || []).filter(x => x === c).length, channel);
  const 경고들 = () => page.evaluate(() => syncFrame().missed.filter(m => m.includes('조견표는')));
  const 모드로 = async m => {
    await page.evaluate(m => {
      const r = document.getElementById(m === 'edit' ? 'mode-edit' : 'mode-new');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    }, m);
    await page.waitForFunction(m => document.getElementById('form-frame').contentWindow.document
      .querySelector('input[name="cpWorkMode"]')?.value === (m === 'edit' ? 'edit' : 'copy'), m, { timeout: 10000 });
    await 채우기끝();
  };
  // 사람이 치듯 input·change 를 쏜다(위 '입력' 과 같다).
  const 좌측 = async values => {
    await page.evaluate(values => {
      for (const [id, value] of Object.entries(values)) {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, values);
    await 채우기끝();
  };
  // 베리씨드 사진 불러오기 버튼. 답으로 올 조견표 주소를 정해 두고 누른다.
  const 사진 = async (region, tag) => {
    await page.evaluate(([region, tag]) => {
      window.__script = window.__script || {};
      window.__script['veryup-load-photo'] = { success: true, path: 'x', name: `${region}-${tag}.jpg`, dataUrl: '',
        html: `<img src="https://cdn.example/${region}-${tag}.jpg">` };
      document.getElementById(region === 'global' ? 'btn-load-global' : 'btn-load-korea').click();
    }, [region, tag]);
    await page.waitForFunction(t => document.getElementById('inp-chart-html').value.includes(t), `${region}-${tag}`);
    await 채우기끝();
  };

  // ── 이베이 수정: 불러온 열쇠(칸에 친 값)로 비교하고, eBay 요청은 서버가 풀어 준 SKU 로 ──
  {
    await 폼.evaluate(() => {
      window.__script = {
        // 서버는 SKU 를 제 표기(대문자)로, Listing ID 는 그 리스팅의 SKU 로 돌려준다.
        'ebay-load-product': arg => ({ success: true, data: {
          sku: /^[0-9]{12}$/.test(arg) ? 'SKU-FROM-LISTING' : String(arg).toUpperCase(),
          offer: { status: 'PUBLISHED', offerId: 'O2', pricingSummary: { price: { value: '10' } }, availableQuantity: 2, listing: { listingId: '123456789012' } },
          inventory: { product: { title: 'loaded' }, availability: {} } } }),
        'ebay-update': { success: true, data: {} },
      };
    });
    const 불러와서수정 = async key => {
      await 폼.evaluate(key => {
        document.getElementById('ebEditSku').value = key;   // 탭 스크립트처럼 — 이벤트 없이
        document.querySelector('[data-eb="load"]').click();
      }, key);
      await 이베이끝();
      const opened = await 폼.evaluate(() => !document.getElementById('ebUpdate').disabled);
      await 폼.evaluate(() => document.querySelector('[data-eb="update"]').click());
      await 이베이끝();
      const sent = await 폼.evaluate(() => (window.__callArgs || []).filter(([c]) => c === 'ebay-update').map(([, a]) => a.sku));
      return { opened, sent: sent.at(-1) };
    };
    const lower = await 불러와서수정('ob-lower-1');
    const listing = await 불러와서수정('123456789012');
    // 불러온 뒤 칸이 이벤트 없이 바뀜 → 칸의 상품과 불러온 상품이 다르다 → 수정·판매 중단 거부
    const before = await 호출수('ebay-update');
    await 폼.evaluate(() => {
      document.getElementById('ebEditSku').value = 'OTHER-SKU';
      document.querySelector('[data-eb="update"]').click();
    });
    await 이베이끝();
    await 폼.evaluate(() => document.querySelector('[data-eb="withdraw"]').click());
    await 이베이끝();
    판정('이베이 수정 — Listing ID·다른 대소문자로 불러온 상품', [
      ['이베이', '소문자로 불러옴: 수정 버튼 열림', lower.opened, true],
      ['이베이', '소문자로 불러옴: 보낸 SKU',      lower.sent, 'OB-LOWER-1'],
      ['이베이', 'Listing ID: 수정 버튼 열림',     listing.opened, true],
      ['이베이', 'Listing ID: 보낸 SKU',           listing.sent, 'SKU-FROM-LISTING'],
      ['이베이', '칸이 바뀐 뒤 수정 요청 안 나감', await 호출수('ebay-update') - before, 0],
      ['이베이', '칸이 바뀐 뒤 판매 중단 안 나감', await 호출수('ebay-withdraw'), 0],
      ['이베이', '거부 알림', (await 이베이로그()).includes('불러온 상품(123456789012)과 지금 조회 칸(OTHER-SKU)이 다릅니다'), true],
    ]);
  }

  // ── 일괄 등록은 신규등록 모드에서만 ──
  {
    await 로그비우기();
    await 폼.evaluate(() => {
      window.__bulk = [];
      window.registerCoupang = async () => { window.__bulk.push('registerCoupang'); return { ok: true }; };
    });
    await page.evaluate(() => runBulkRegister());
    판정('일괄 등록 — 수정 모드에서 누름', [
      ['셸 로그', '거부 알림', (await 로그()).includes('일괄 등록은 신규등록 모드에서만 할 수 있습니다'), true],
      ['쿠팡',    '등록 함수 안 불림', (await 폼.evaluate(() => window.__bulk.length)), 0],
    ]);
  }

  await 모드로('new');

  // ── 조견표·이베이 이미지 (이미지 목록 VUImages 가 없을 때 — 셸이 조견표를 이베이에 넘기는 길) ──
  {
    await page.evaluate(() => { window.__savedVUImages = window.VUImages; window.VUImages = undefined; });
    await page.evaluate(() => openPlatformTab('ebayTab', 'USA'));
    await 좌측({ 'inp-brand': '기아', 'inp-carmodel': 'EV3', 'inp-no': 'K138' });
    // GLOBAL 만 불러왔으면 국내 몰(네이버) 상세에 영문 조견표를 넣지 않고 알린다.
    const 네이버켬 = await page.evaluate(() => { const was = !!checked.KOREA.open1; chartHtmlByRegion.korea = ''; handleCheck('KOREA', 'open1', true, null, { quiet: true }); return was; });
    await 사진('global', 'Z');
    const 해외만 = await page.evaluate(() => ({ missed: syncFrame().missed, naver: document.getElementById('form-frame').contentDocument.getElementById('naverEsmHtml').value }));
    await page.evaluate(was => handleCheck('KOREA', 'open1', was, null, { quiet: true }), 네이버켬);
    await 채우기끝();
    판정('조견표 — GLOBAL 만 불러옴', [
      ['네이버',  '영문 조견표 안 들어감', 해외만.naver.includes('global-Z'), false],
      ['셸 경고', '국내용 없음 알림',      해외만.missed.some(m => m.startsWith('국내용(KOREA) 조견표가 없습니다')), true],
    ]);
    await 사진('korea', 'A');
    await 사진('global', 'A');
    const 처음 = await 이베이이미지();
    // 사람이 이미지를 하나 적고, 'ESM 이미지 가져오기' 로 국내용 조견표도 넣는다.
    await 숨김풀고(() => page.frameLocator('#form-frame').locator('#ebImages').fill(`${처음}\nhttps://user.example/mine.jpg`));
    await 폼.evaluate(() => document.querySelector('[data-eb="importEsm"]').click());
    await 이베이끝();
    const 사람까지 = await 이베이이미지();
    // 차를 바꾸고 사진은 다시 안 불러옴 → 경고
    await 좌측({ 'inp-brand': 'BMW', 'inp-carmodel': '1시리즈', 'inp-no': '101' });
    const 바꾼뒤경고 = await 경고들();
    const 바꾼뒤 = await 이베이이미지();
    // 새 차 사진을 불러옴 → 조견표를 바꿔 끼우고 사람 것은 남긴다, 경고 사라짐
    await 사진('korea', 'B');
    await 사진('global', 'B');
    const 새사진 = await 이베이이미지();
    const 새사진경고 = await 경고들();
    판정('조견표 — 다른 차로 불러온 조견표 · 이베이 이미지 바꿔 끼우기', [
      ['이베이', '해외용 조견표가 들어감',    처음, 'https://cdn.example/global-A.jpg'],
      ['이베이', '사람 것 추가',              사람까지, 'https://cdn.example/global-A.jpg\nhttps://user.example/mine.jpg\nhttps://cdn.example/korea-A.jpg'],
      ['셸 경고', '국내용: 앞 차 조견표',     바꾼뒤경고.some(m => m.startsWith("KOREA(국내용) 조견표는 '기아 EV3 No.K138' 차로 불러온 것입니다")), true],
      ['셸 경고', '해외용: 앞 차 조견표',     바꾼뒤경고.some(m => m.startsWith("GLOBAL(해외용) 조견표는 '기아 EV3 No.K138' 차로 불러온 것입니다")), true],
      ['이베이', '사진 안 바꾸면 그대로',     바꾼뒤, 사람까지],
      ['이베이', '새 조견표로 바꿔 끼움',     새사진, 'https://cdn.example/global-B.jpg\nhttps://user.example/mine.jpg\nhttps://cdn.example/korea-A.jpg'],
      ['셸 경고', '새 사진 뒤 경고 없음',     새사진경고.length, 0],
    ]);

    // 차를 넣기 전에 불러온 사진은 그다음 넣은 차가 가져간다(경고 없음). 그 차에서 다른 차로 가면 경고.
    await 좌측({ 'inp-brand': '', 'inp-carmodel': '', 'inp-no': '' });
    await 사진('korea', 'C');
    await 사진('global', 'C');
    await 좌측({ 'inp-brand': '혼다', 'inp-carmodel': '시빅', 'inp-no': '1213' });
    const 가져간뒤 = await 경고들();
    await 좌측({ 'inp-brand': 'BMW', 'inp-carmodel': '1시리즈', 'inp-no': '101' });
    const 다른차 = await 경고들();
    // 사람이 조견표 칸을 직접 고치면(지금 칸은 GLOBAL) 해외용 조견표가 그 값이 된다 — 이베이도 그걸 쓴다.
    await page.locator('#inp-chart-html').fill('<img src="https://cdn.example/hand-D.jpg">');
    await 채우기끝();
    const 손으로 = await 이베이이미지();
    const 손으로경고 = await 경고들();
    const 해외용 = await page.evaluate(() => chartHtmlByRegion.global);
    // 해외용을 지우면 이베이는 국내용으로 대신한다.
    await page.locator('#inp-chart-html').fill('');
    await 채우기끝();
    const 국내용대신 = await 이베이이미지();
    // 이미지 목록이 돌아오면 이베이 이미지는 목록이 정한다 — 셸이 넣었던 조견표는 빠지고 사람 것만 남는다.
    await page.evaluate(() => { window.VUImages = window.__savedVUImages; });
    await page.evaluate(() => syncFrame());
    const 목록복귀 = await 이베이이미지();
    판정('조견표 — 먼저 불러온 사진 · 손으로 고친 조견표 칸', [
      ['셸 경고', '사진 먼저 → 넣은 차가 가져감', 가져간뒤.length, 0],
      ['셸 경고', '그 뒤 다른 차: 경고',        다른차.some(m => m.includes("조견표는 '혼다 시빅 No.1213' 차로")), true],
      ['셸',      '손으로 고친 칸 = 해외용',     해외용, '<img src="https://cdn.example/hand-D.jpg">'],
      ['이베이',  '손으로 고친 조견표로 바꿈',   손으로, 'https://cdn.example/hand-D.jpg\nhttps://user.example/mine.jpg\nhttps://cdn.example/korea-A.jpg'],
      ['셸 경고', '해외용 경고 사라짐',         손으로경고.some(m => m.startsWith('GLOBAL')), false],
      ['셸 경고', '국내용 경고는 남음',         손으로경고.some(m => m.startsWith('KOREA')), true],
      ['이베이',  '해외용 없으면 국내용',       국내용대신, 'https://cdn.example/korea-C.jpg\nhttps://user.example/mine.jpg\nhttps://cdn.example/korea-A.jpg'],
      ['이베이',  '이미지 목록이면 조견표 뺌',   목록복귀, 'https://user.example/mine.jpg\nhttps://cdn.example/korea-A.jpg'],
    ]);
  }

  // ── 일괄 등록: 몰마다 받은 결과대로 센다 ──
  await page.evaluate(() => {
    bulkTiming.pauseMs = 0;
    // 이베이 초안은 이미지 목록을 준비한 뒤 나간다(image-payload.js) — 목록 답을 정해 둔다.
    window.__script = window.__script || {};
    window.__script['image-library-load'] = { success: true, profiles: [] };
    window.__script['image-library-prepare'] = { success: true,
      profile: { id: 'ebay', label: 'eBay', folder: '', items: [], errors: [] },
      bundle: { imageUrls: ['https://img.example/eb-1.jpg'] } };
  });
  await 폼.evaluate(() => {
    window.__bulk = [];
    window.__bulkPlan = {};
    for (const fn of ['registerNaver', 'registerCoupang', 'registerImwebB2b', 'registerImwebBoard', 'registerAmazon']) {
      window[fn] = () => {
        window.__bulk.push({ fn, cpMode: document.querySelector('input[name="cpWorkMode"]').value,
          amzMode: document.querySelector('input[name="amzWorkMode"]').value,
          market: document.getElementById('amzMarketplaceId').value });
        const plan = window.__bulkPlan[fn];
        return typeof plan === 'function' ? plan() : Promise.resolve(plan);
      };
    }
  });
  const 일괄 = async (plan, ebay) => {
    await 로그비우기();
    await 폼.evaluate(([plan, ebay]) => {
      window.__bulk = [];
      window.__bulkPlan = plan;
      window.__callArgs = [];
      window.__script = { 'ebay-save-draft': ebay };
    }, [plan, ebay]);
    await page.evaluate(() => runBulkRegister());
    return 로그();
  };
  const 다성공 = { registerNaver: { ok: true }, registerCoupang: { ok: true }, registerImwebB2b: { ok: true },
                  registerImwebBoard: { ok: true }, registerAmazon: { ok: true } };
  const 이베이성공 = { success: true, data: { sku: 'OBM0103N101', offerId: 'OFF-1' } };
  {
    const log = await 일괄({
      registerNaver: { ok: true },
      registerCoupang: { ok: false, error: '쿠팡 거부: 옵션 형식 오류' },
      registerImwebB2b: { ok: false, partial: true, error: '세트 상품: 이미지 업로드 실패' },
      registerImwebBoard: undefined,   // 예전 모양 — 아무것도 안 돌려줌
      registerAmazon: { ok: true },
    }, 이베이성공);
    const drafts = await 폼.evaluate(() => (window.__callArgs || []).filter(([c]) => c === 'ebay-save-draft').length);
    // 던지는 등록 함수(예전 코드)는 따로 — 계획표는 JSON 으로만 넘어가서 함수를 못 담는다.
    const log2 = await (async () => {
      await 로그비우기();
      await 폼.evaluate(() => {
        window.__bulk = [];
        window.__bulkPlan = { registerNaver: { ok: true }, registerCoupang: { ok: true }, registerImwebB2b: { ok: true },
          registerImwebBoard: { ok: true }, registerAmazon: () => { throw new Error('아마존 폼 오류'); } };
      });
      await page.evaluate(() => runBulkRegister());
      return 로그();
    })();
    판정('일괄 등록 — 성공·실패·일부·예전 모양', [
      ['셸 로그', '네이버 성공',            log.includes('[네이버] 등록 완료'), true],
      ['셸 로그', '쿠팡 거부 = 실패',       log.includes('[쿠팡] 등록 실패: 쿠팡 거부: 옵션 형식 오류'), true],
      ['셸 로그', 'B2B 일부만',             log.includes('⚠ [아임웹 B2B몰] 일부만 등록: 세트 상품: 이미지 업로드 실패'), true],
      ['셸 로그', '결과 없음 = 실패',       log.includes('[아임웹 자사몰/게시판] 등록 실패: 등록 결과를 받지 못했습니다'), true],
      ['셸 로그', '이베이 초안 저장됨',      log.includes('[eBay 미국] 초안 저장 완료'), true],
      ['셸 로그', '요약',                   log.includes('일괄 등록 완료 (성공: 3건, 실패: 3건 · 그중 일부만 등록 1건)'), true],
      ['셸 로그', '다시 볼 몰',             log.includes('다시 확인할 몰: 쿠팡, 아임웹 B2B몰, 아임웹 자사몰/게시판'), true],
      ['이베이',  '초안 요청 한 번 나감',    drafts, 1],
      ['셸 로그', '던진 아마존 = 실패',      log2.includes('[아마존 미국] 등록 실패: 아마존 폼 오류'), true],
      ['셸 로그', '던져도 끝까지 감',        log2.includes('일괄 등록 완료 (성공: 5건, 실패: 1건)'), true],
    ]);
  }
  {
    // 입력 확인 경고가 있을 때 confirm 을 거절하면 어느 몰에도 보내지 않는다.
    확인답 = false;
    const log = await 일괄(다성공, 이베이성공);
    확인답 = true;
    const sent = await 폼.evaluate(() => window.__bulk.length);
    판정('일괄 등록 — 경고 확인창에서 취소', [
      ['셸 로그', '취소 안내',              log.includes('일괄 등록을 취소했습니다'), true],
      ['폼',      '등록 함수 안 부름',       sent, 0],
    ]);
  }
  {
    // 응답 없는 몰은 시간 한도에서 실패로 끝내고 다음 몰로 간다. 이베이가 거부하면 그 이유가 셸 로그에 온다.
    await page.evaluate(() => { bulkTiming.stepMs = 400; });
    await 로그비우기();
    await 폼.evaluate(() => {
      window.__bulk = [];
      window.__bulkPlan = { registerNaver: () => new Promise(() => {}), registerCoupang: { ok: true }, registerImwebB2b: { ok: true },
        registerImwebBoard: { ok: true }, registerAmazon: { ok: true } };
      window.__script = { 'ebay-save-draft': { success: false, error: 'eBay 거부: 카테고리 ID 가 없습니다' } };
    });
    await page.evaluate(() => runBulkRegister());
    const log = await 로그();
    const after = await page.evaluate(() => ({ running: isBulkRunning, disabled: document.getElementById('btn-bulk-register').disabled }));
    await page.evaluate(() => { bulkTiming.stepMs = 10 * 60 * 1000; });
    판정('일괄 등록 — 응답 없는 몰 · 이베이 거부', [
      ['셸 로그', '시간 한도 = 실패',        log.includes('[네이버] 등록 실패: 1초 안에 끝나지 않았습니다'), true],
      ['셸 로그', '이베이 거부 이유',        log.includes('[eBay 미국] 등록 실패: eBay 거부: 카테고리 ID 가 없습니다'), true],
      ['셸 로그', '요약',                   log.includes('일괄 등록 완료 (성공: 4건, 실패: 2건)'), true],
      ['셸',      '진행 중 풀림',            after.running, false],
      ['셸',      '버튼 다시 켜짐',          after.disabled, false],
    ]);
  }
  {
    // 도중에 모드를 바꾸려 하면 거절한다 — 라디오든 메인 프로세스의 알림이든.
    await 로그비우기();
    await 폼.evaluate(([plan, ebay]) => {
      window.__bulk = [];
      window.__bulkPlan = { ...plan, registerCoupang: () => new Promise(r => { window.__release = () => r({ ok: true }); }) };
      window.__release = null;
      window.__script = { 'ebay-save-draft': ebay };
    }, [다성공, 이베이성공]);
    await page.evaluate(() => { window.__sent = []; window.__bulkRun = runBulkRegister(); });
    await 폼.waitForFunction(() => typeof window.__release === 'function', null, { timeout: 10000 });
    await page.evaluate(() => {
      const r = document.getElementById('mode-edit');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
      window.__listeners['veryup-set-mode'].forEach(fn => fn({}, 'edit'));
    });
    const during = await page.evaluate(() => ({ mode: currentMode, newChecked: document.getElementById('mode-new').checked,
      resync: (window.__sent || []).some(([c, m]) => c === 'veryup-set-mode' && m === 'new') }));
    await 폼.evaluate(() => window.__release());
    await page.evaluate(() => window.__bulkRun);
    const log = await 로그();
    const later = await 폼.evaluate(() => window.__bulk.filter(b => ['registerImwebB2b', 'registerImwebBoard', 'registerAmazon'].includes(b.fn))
      .map(b => `${b.cpMode}/${b.amzMode}`));
    판정('일괄 등록 — 도중 모드 전환 거절', [
      ['셸', '모드 그대로 신규',              during.mode, 'new'],
      ['셸', '신규 라디오로 되돌림',          during.newChecked, true],
      ['셸', '메인에 신규로 다시 알림',       during.resync, true],
      ['셸 로그', '거절 알림',                log.includes('일괄 등록 중에는 모드를 바꿀 수 없습니다'), true],
      ['쇼핑몰 폼', '남은 몰은 신규 등록으로', later.join(' '), 'copy/register copy/register copy/register'],
      ['셸 로그', '요약',                     log.includes('일괄 등록 완료 (성공: 6건, 실패: 0건)'), true],
    ]);
  }
  {
    // 일괄 등록이 도는 사이 좌측을 고쳐도 남은 몰은 시작할 때 값으로 올라가고, 끝나면 그때 새 값이 들어간다.
    const 원래코드 = await page.evaluate(() => document.getElementById('inp-code').value);
    const 시작코드 = await 폼.evaluate(() => document.getElementById('amzCode').value);
    await 로그비우기();
    await 폼.evaluate(([plan, ebay]) => {
      window.__bulk = [];
      window.__bulkPlan = { ...plan,
        registerCoupang: () => new Promise(r => { window.__release = () => r({ ok: true }); }),
        registerAmazon: () => { window.__amzCode = document.getElementById('amzCode').value; return { ok: true }; } };
      window.__release = null;
      window.__script = { 'ebay-save-draft': ebay };
    }, [다성공, 이베이성공]);
    await page.evaluate(() => { window.__bulkRun = runBulkRegister(); });
    await 폼.waitForFunction(() => typeof window.__release === 'function', null, { timeout: 10000 });
    await 좌측({ 'inp-code': 'MIDRUN-1' });
    await 폼.evaluate(() => window.__release());
    await page.evaluate(() => window.__bulkRun);
    const 도중 = await 폼.evaluate(() => window.__amzCode);
    await 채우기끝();
    const 끝난뒤 = await 폼.evaluate(() => document.getElementById('amzCode').value);
    await 좌측({ 'inp-code': 원래코드 });
    판정('일괄 등록 — 도중에 좌측을 고침', [
      ['아마존', '남은 몰은 시작할 때 값으로', 도중, 시작코드],
      ['아마존', '끝나면 새 값이 들어감',     끝난뒤, 'MIDRUN-1'],
    ]);
  }
  {
    // 아마존 미국·일본을 둘 다 켜면 채우기가 채운 마켓(마지막으로 누른 칸)에만 올리고, 다른 마켓은 안 올렸다고 알린다.
    await page.evaluate(() => { handleCheck('JAPAN', 'open1', true); openPlatformTab('amazonTab', 'USA'); });
    await 채우기끝();
    const us = await 일괄(다성공, 이베이성공);
    const usMarket = await 폼.evaluate(() => window.__bulk.find(b => b.fn === 'registerAmazon')?.market);
    const usLast = await page.evaluate(() => lastAmazonCountry);
    await page.evaluate(() => openPlatformTab('amazonTab', 'JAPAN'));
    await 채우기끝();
    // 현황판에는 지금 올리는 마켓 칸만 '열림' 으로 표시된다(가운데 쇼핑몰 탭을 현황판으로 합쳤다).
    const viewing = () => page.evaluate(() => [...document.querySelectorAll('#board-body .platform-cell.viewing')].map(td => td.dataset.country + '-' + td.dataset.type).join(','));
    const jpViewing = await viewing();
    const jp = await 일괄(다성공, 이베이성공);
    const jpMarket = await 폼.evaluate(() => window.__bulk.find(b => b.fn === 'registerAmazon')?.market);
    await page.evaluate(() => openPlatformTab('amazonTab', 'USA'));
    await 채우기끝();
    const usViewing = await viewing();
    await page.evaluate(() => handleCheck('JAPAN', 'open1', false));
    await 채우기끝();
    판정('일괄 등록 — 아마존 미국·일본 둘 다 켬', [
      ['아마존',  '미국 칸 누름 → 미국 마켓',  usMarket, 'ATVPDKIKX0DER'],
      ['셸 로그', '미국으로 등록',             us.includes('[아마존 미국] 등록 완료'), true],
      ['셸 로그', '일본은 안 올렸다고 알림',   us.includes('일본 아마존은 이번에 올리지 않았습니다'), true],
      ['셸',      '누른 나라 그대로',          usLast, 'USA'],
      ['아마존',  '일본 칸 누름 → 일본 마켓',  jpMarket, 'A1VC38T7YXB528'],
      ['셸 로그', '일본으로 등록',             jp.includes('[아마존 일본] 등록 완료'), true],
      ['셸 로그', '미국은 안 올렸다고 알림',   jp.includes('미국 아마존은 이번에 올리지 않았습니다'), true],
      ['셸',      '일본 마켓 → 현황판 일본 아마존 칸만 열림', jpViewing, 'JAPAN-open1'],
      ['셸',      '미국 마켓 → 현황판 미국 아마존 칸만 열림', usViewing, 'USA-open1'],
    ]);
  }

  console.log(`\n${전체 - 틀림.length}/${전체} 칸 일치`);
  if (pageErrors.length) console.log('페이지 오류:', pageErrors);

  assert.equal(틀림.length, 0, `좌측 상품 정보와 다른 칸 ${틀림.length}개:\n  ` + 틀림.join('\n  '));
} finally {
  await browser.close();
}
