// Only Coupang uses the AWS relay. Other marketplaces call their APIs directly.
export function resolveRuntimeProxy({ platform, baseUrl, token, env = process.env }) {
    if (platform !== 'coupang' || env.USE_SERVER_PROXY === '0' || !token) return null;
    return { proxyUrl: baseUrl, proxyToken: token };
}
