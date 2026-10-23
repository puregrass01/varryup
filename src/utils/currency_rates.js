import fs from 'node:fs';
import { writeJsonAtomic } from './json_file.js';

export const DAY = 86400000;
export const REFRESH = 60 * 60 * 1000;   // 받은 환율은 1시간 동안 다시 받지 않는다
export const RETRY = 15 * 60 * 1000;     // 받지 못하면 15분 뒤에 다시 시도한다(서버 currency_rates.py 와 같다)
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const SANE = { KRW: [500, 5000], JPY: [30, 500] };   // 이 범위 밖이면 시세 오류로 보고 쓰지 않는다

export function validRates(data) {
  return data?.base === 'USD' && data?.rates?.USD === 1 &&
    ['USD', 'JPY', 'KRW'].every(c => typeof data.rates[c] === 'number' && Number.isFinite(data.rates[c]) && data.rates[c] > 0) &&
    Number.isFinite(Date.parse(data.fetchedAt)) && /^\d{4}-\d{2}-\d{2}$/.test(data.marketDate);
}

/** Yahoo 차트 응답의 날짜별 값. 오늘 일봉은 비어 있고 실시간 값이 같은 날짜로 끝에 붙어 온다. 날짜는 거래소(런던) 기준이다. */
export function dailyCloses(body) {
  const result = body?.chart?.result?.[0];
  const offset = Number(result?.meta?.gmtoffset) || 0;
  const times = result?.timestamp || [], closes = result?.indicators?.quote?.[0]?.close || [];
  const byDate = new Map();
  times.forEach((time, i) => {
    const value = closes[i];
    if (Number.isFinite(time) && typeof value === 'number' && Number.isFinite(value) && value > 0)
      byDate.set(new Date((time + offset) * 1000).toISOString().slice(0, 10), value);
  });
  return byDate;
}

/**
 * 관리 서버 없이 앱이 Yahoo Finance 에서 직접 받는다(2026-09-30, 서버에 환율 기능이 배포되지 않았다).
 * 서버 currency_rates.py(yfinance)와 같은 규칙: KRW=X·JPY=X 최근 5거래일 일별 값 중 두 통화에 모두 있는 가장 최근 날짜.
 */
export async function fetchYahooRates({ fetchImpl = fetch, clock = Date.now } = {}) {
  const series = {};
  for (const [code, symbol] of [['KRW', 'KRW=X'], ['JPY', 'JPY=X']]) {
    let failure = null;
    for (const host of YAHOO_HOSTS) {
      try {
        const response = await fetchImpl(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
          headers: { 'User-Agent': 'VERYUP/3.0 (+currency-rates)', Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error('Yahoo 환율 응답 오류 (HTTP ' + response.status + ')');
        series[code] = dailyCloses(await response.json());
        if (!series[code].size) throw new Error('Yahoo 환율 데이터가 비어 있습니다.');
        failure = null;
        break;
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  }
  const marketDate = [...series.KRW.keys()].filter(date => series.JPY.has(date)).sort().at(-1);
  if (!marketDate) throw new Error('달러/원·달러/엔 공통 기준일이 없습니다.');
  const rates = { USD: 1, JPY: series.JPY.get(marketDate), KRW: series.KRW.get(marketDate) };
  for (const [code, [low, high]] of Object.entries(SANE)) {
    if (!(rates[code] >= low && rates[code] <= high)) throw new Error(`환율 값이 비정상입니다 (${code} ${rates[code]}).`);
  }
  return { base: 'USD', source: 'Yahoo Finance (앱 직접 조회)', marketDate, rates, fetchedAt: new Date(clock()).toISOString() };
}

export class CurrencyRatesClient {
  constructor({ cachePath, fetchImpl = fetch, clock = Date.now, direct = fetchYahooRates }) {
    Object.assign(this, { cachePath, fetchImpl, clock, direct });
    this.pending = null;
    this.cache = null;
    this.failure = '';
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (validRates(data)) this.cache = data;
    } catch {}
    // 저장해 둔 값이 1시간 안에 받은 것이면 앱을 다시 켜도 바로 다시 받지 않는다. 미래 시각이면 곧바로 다시 받는다.
    const fetched = this.cache ? Date.parse(this.cache.fetchedAt) : NaN;
    this.nextFetch = fetched <= this.clock() ? fetched + (this.cache?.stale ? RETRY : REFRESH) : 0;
  }

  get() {
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  // 앱이 직접 받고, 안 되면 저장해 둔 값을 쓴다. (관리 서버 환율은 운영에 배포된 적이 없어 404 였다 — 2026-10-23 지움.)
  async load() {
    const now = this.clock();
    if (now < this.nextFetch) return this.result(this.failure || undefined, !!this.failure);
    try { return this.commit(await this.direct({ fetchImpl: this.fetchImpl, clock: this.clock }), now); }
    catch (error) {
      this.nextFetch = now + RETRY;
      this.failure = '환율을 새로 받지 못했습니다: ' + error.message;
      return this.result(this.failure, true);
    }
  }

  // 올바른 값만 받아들인다. 틀린 응답은 던져서 다음 경로로 넘기고, 저장해 둔 값을 덮어쓰지 않는다.
  commit(data, now) {
    if (!validRates(data)) throw new Error('환율 데이터가 올바르지 않습니다.');
    const { base, source, marketDate, rates, fetchedAt } = data;
    // 서버가 명시한 만료 여부도 보존한다. 수집 시각만 최근이라고 가격 계산에 쓰면 안 된다.
    this.cache = { base, source, marketDate, rates, fetchedAt, stale: data.stale === true,
      warning: typeof data.warning === 'string' ? data.warning : null };
    this.failure = '';
    this.nextFetch = now + (this.cache.stale ? RETRY : REFRESH);
    try {
      writeJsonAtomic(this.cachePath, this.cache, 0);
    } catch {
      return this.result('환율은 조회했지만 로컬 캐시를 저장하지 못했습니다.');
    }
    return this.result();
  }

  result(warning, offline = false) {
    if (!this.cache) return { success: false, error: warning || '환율 데이터가 없습니다.' };
    const age = this.clock() - Date.parse(this.cache.fetchedAt);
    return { success: true, data: { ...this.cache, offline,
      stale: this.cache.stale === true || age < 0 || age >= DAY,
      warning: warning || this.cache.warning || null } };
  }
}
