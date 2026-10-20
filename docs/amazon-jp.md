# 아마존 일본 SP-API

API KEY → 아마존 → 아마존 일본 SP-API에서 일본 Refresh Token을 저장하고 **일본 연결 확인**을 실행합니다.

- 기본 Seller ID·LWA Client ID·Client Secret과 같은 값을 사용하는 경우 일본의 해당 칸은 비워둡니다. 공통 설정은 먼저 저장해야 합니다.
- 별도 일본 계정/앱이면 일본 Seller ID와 LWA Client ID·Client Secret도 입력합니다. 미국 인증정보 없이 일본 전용 4개 값만 저장해도 일본 API를 사용할 수 있습니다.
- 일본 설정 저장은 `jpSellerId`, `jpClientId`, `jpClientSecret`, `jpRefreshToken`만 갱신하므로 미국 설정을 덮어쓰지 않습니다.
- 일괄수정 → 아마존 일본에서 목록 조회/동기화, JPY 가격 및 이미지 변경을 사용합니다. 조회·수정·리포트는 일본 판매자 계정으로 전송합니다.
- 연결 확인은 토큰 발급에 이어 일본 마켓에 실제로 판매 참여 중인지 검사합니다. HTTP 200이어도 일본 참여 정보가 없으면 성공으로 표시하지 않습니다.
- 캐시와 신규등록 중복 판정은 일본 Seller ID 및 마켓 ID를 사용합니다. 캐시는 마켓마다 따로 보관합니다(`amazon_listings_cache_{마켓 ID}.json`, 2026-10-08). 예전에는 한 파일이라 일본을 동기화하면 미국 목록이 지워졌습니다 — 예전 파일은 앱이 처음 뜰 때 그 마켓 파일로 옮깁니다.
- 캐시가 없는 마켓은 API로 조회하는데, 아마존이 1000건에서 페이지를 끊습니다. 그러면 상품 일괄 수정 목록에 경고가 뜨고 환율 자동 변경은 그 마켓을 멈춥니다 — 그 마켓으로 **전체 목록 동기화**를 먼저 실행하세요.
- 요청은 PC에서 직접 전송합니다. 일본 마켓 ID는 `A1VC38T7YXB528`, SP-API 엔드포인트는 `https://sellingpartnerapi-fe.amazon.com`입니다.

설정 변경 후 앱을 다시 실행합니다. 실제 판매자 토큰으로 연결 성공 여부는 사용자 환경에서 확인해야 합니다. 회귀 테스트는 더미 인증정보와 모의 API 응답을 사용하며 운영 상품을 수정하지 않습니다.

공식 자료:
- [Amazon SP-API 엔드포인트](https://developer-docs.amazon/sp-api/docs/sp-api-endpoints)
- [Amazon 마켓플레이스 ID](https://developer-docs.amazon/sp-api/docs/marketplace-ids)
- [마켓 참여 조회](https://developer-docs.amazon/sp-api/reference/getmarketplaceparticipations)

검증: `node --test tests/amazon-jp.test.mjs tests/amazon-settings.test.mjs tests/amazon-cache.test.mjs tests/amazon-update.test.mjs`
