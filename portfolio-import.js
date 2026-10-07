import { getKuwaitStock } from './kuwait-stocks.js';

// A link carries only the requested holdings; existing device data is preserved.
export function parsePortfolioLink(hash) {
  if (!hash.startsWith('#stocks=')) return null;
  if (hash.length > 12000) throw new Error('رابط المحفظة طويل أو غير صالح.');
  const payload = JSON.parse(decodeURIComponent(hash.slice(8)));
  if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 20 ||
      typeof payload.at !== 'string' || Number.isNaN(Date.parse(payload.at))) throw new Error('بيانات المحفظة غير صالحة.');
  const codes = new Set();
  const holdings = payload.rows.map(row => {
    if (!Array.isArray(row) || row.length !== 4) throw new Error('بيانات سهم غير مكتملة.');
    const [code, quantity, purchasePriceTenths, currentPriceTenths] = row;
    const security = getKuwaitStock(code);
    if (!security || codes.has(security.code) || ![quantity, purchasePriceTenths, currentPriceTenths].every(n => Number.isSafeInteger(n) && n > 0 && n <= 100000000)) throw new Error('راجع السهم والكمية والأسعار.');
    codes.add(security.code);
    return { securityCode: security.code, quantity, purchasePriceTenths, currentPriceTenths, feesFils: 0, priceUpdatedAt: payload.at };
  });
  return holdings;
}

export function newPortfolioHoldings(existing, incoming) {
  const codes = new Set(existing.map(item => item.securityCode));
  return incoming.filter(item => !codes.has(item.securityCode));
}
