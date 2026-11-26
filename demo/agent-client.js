'use strict';

const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { chooseOffers } = require('../agent');
const policy = require('../optimized-policy-v2.json');
const { estimate, meets, round } = require('./value');
const types = {
  INSTANT: { name: 'Instant', markup: 0.93 },
  COMMERCIAL: { name: 'Commercial', markup: 0.985 },
  SPECIALTY: { name: 'Specialty', markup: 1 },
};

async function play(base, signal) {
  async function call(path, body) {
    const response = await fetch(new URL(path, base), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: { 'x-demo-client': 'optimized-v2', ...(body && { 'content-type': 'application/json' }) },
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(`${path}: ${data.error?.message || response.status}`), { status: response.status });
    }
    return data;
  }

  const { rules } = await call('/v1/calendar');
  const acted = new Set();
  while (!signal.aborted) {
    const state = await call('/v1/state');
    if (state.phase === 'CLOSED') return;
    const items = state.lots.map(lot => {
      const { grade, tv } = estimate(rules, lot.sample);
      return { lot_id: lot.lot_id, grade, est_value_per_kg: tv };
    });
    if (state.phase === 'APPRAISAL' && !state.appraisal_submitted) {
      try {
        await call('/v1/appraisals', { items });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    const period = state.round;
    if (state.phase === 'ROUND_OPEN' && !state.paused && !acted.has(period.round_id)) {
      if (!state.my_open_offers.length) {
        const bag = rules.bag_kg;
        const lots = state.lots.map((lot, index) => ({
          id: lot.lot_id, sample: lot.sample, tv: items[index].est_value_per_kg,
          left: Math.floor(lot.kg_available / bag), eligible: 0, priceFailures: {},
        }));
        const buyers = state.rfqs.filter(rfq => types[rfq.buyer_type]).map(rfq => ({
          ...types[rfq.buyer_type], id: rfq.rfq_id, bags: rfq.bags,
          accepts: lot => meets(lot.sample, rfq.spec),
        }));
        const offers = chooseOffers(lots, buyers, Math.floor(state.capacity_left_kg / bag),
          period.number, period.of, policy).map(({ lot, buyer, bags, markup }) => ({
          lot_id: lot.id, rfq_id: buyers.find(b => b.name === buyer).id,
          kg: bags * bag, price_per_kg: round(lot.tv * markup),
        }));
        try {
          await call('/v1/offers:batch', { offers, replace_existing: true });
        } catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
          const current = await call('/v1/state');
          if (current.phase === 'ROUND_OPEN' && current.round.round_id === period.round_id) throw error;
        }
      }
      acted.add(period.round_id);
    }
    await sleep(300, undefined, { signal });
  }
}

module.exports = { play };

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());

  async function main() {
    try {
      process.loadEnvFile(path.join(__dirname, '..', '.env'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let url;
    try {
      url = new URL(process.env.MARKET_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new Error('Set MARKET_URL=http://<market-ip>:8787 in the project .env file.');
    }
    console.log(`Connecting optimized-v2 to ${url.origin}`);
    await play(url.origin, controller.signal);
    console.log('Market closed.');
  }

  main().catch(error => {
    if (controller.signal.aborted) return;
    console.error(`Agent: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
    process.exitCode = 1;
  });
}
