'use strict';

const { rules, estimate, meets, round } = require('./value');
const BAG = rules.bag_kg;
const buyerTypes = [
  { buyer: 'รับซื้อทันที', buyer_type: 'INSTANT', cutoff: 0.96, spec: [16, 15, null] },
  { buyer: 'โรงคั่วพาณิชย์', buyer_type: 'COMMERCIAL', cutoff: 1.025, spec: [8, 13.5, 13] },
  { buyer: 'โรงคั่วสเปเชียลตี้', buyer_type: 'SPECIALTY', cutoff: 1.06, spec: [4.5, 12.5, 15] },
];
const calendar = Array.from({ length: 16 }, (_, number) => ({
  round_id: number ? `R${number}` : 'P1',
  kind: number ? 'real' : 'practice',
  number, of: 15, counts_for_score: Boolean(number),
  calendar: !number ? 'รอบซ้อม' : number >= 13 ? 'ความต้องการลดลง'
    : number >= 6 && number <= 8 ? 'เทศกาลกาแฟ' : 'ปกติ',
}));

function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function fail(status, code, message, allowed) {
  throw Object.assign(new Error(message), { status, code, allowed });
}

class DemoMarket {
  constructor(seed = 28) {
    this.reset(seed);
  }

  reset(seed) {
    this.seed = seed;
    this.rand = random(seed);
    this.phase = 'WAITING';
    this.roundIndex = -1;
    this.serial = 0;
    this.revenue = 0;
    this.appraisals = null;
    this.offers = [];
    this.rfqs = [];
    this.results = [];
    this.events = [];
    this.profile ??= { team_name: 'Track 3 Demo', university: '' };
    const types = [
      [420, 'ชุมพร', 'Washed', 3.3, 11.8, 16],
      [360, 'ระนอง', 'Natural', 10.1, 13, 13],
      [420, 'สุราษฎร์ธานี', 'Washed', 3.8, 12, 15],
      [300, 'นครศรีธรรมราช', 'Honey', 6.1, 12.5, 14],
    ];
    this.lots = types.map(([kg, origin, process, defect, moisture, screen], i) => {
      const truth = { defect_pct: round(defect + this.rand() - 0.5), moisture_pct: moisture, screen };
      const sample = { ...truth, defect_pct: round(truth.defect_pct + (this.rand() - 0.5) * 1.35),
        moisture_pct: round(moisture + (this.rand() - 0.5) * 0.5) };
      return { lot_id: `LOT-T28-${i + 1}`, kg_total: kg, kg_remaining: kg, origin, process,
        sample, truth, tv: estimate(rules, truth).tv };
    });
  }

  standings() {
    const kg_total = this.lots.reduce((sum, lot) => sum + lot.kg_total, 0);
    const kg_remaining = this.lots.reduce((sum, lot) => sum + lot.kg_remaining, 0);
    const kg_sold = kg_total - kg_remaining;
    return { revenue_thb: round(this.revenue), kg_sold, kg_remaining, kg_total,
      avg_price_per_kg: kg_sold ? round(this.revenue / kg_sold) : null };
  }

  state(secondsLeft = null) {
    const open = this.phase === 'ROUND_OPEN' ? this.offers : [];
    const cap = this.roundIndex >= 13 ? 180 : 300;
    const lots = this.lots.map(({ truth, tv, ...lot }) => {
      const held = open.filter(o => o.lot_id === lot.lot_id).reduce((sum, o) => sum + o.kg, 0);
      return { ...lot, kg_in_open_offers: held, kg_available: lot.kg_remaining - held };
    });
    return { market: 'sandbox', team_id: 'T28', phase: this.phase, paused: false,
      seconds_left: secondsLeft, phase_ends_at: secondsLeft == null ? null : Date.now() / 1000 + secondsLeft,
      round: calendar[this.roundIndex] || null, lots,
      rfqs: this.phase === 'ROUND_OPEN' ? this.rfqs.map(({ cutoff, competing, ...rfq }) => rfq) : [],
      my_open_offers: open, round_capacity_kg: cap,
      capacity_left_kg: cap - open.reduce((sum, o) => sum + o.kg, 0),
      appraisal_submitted: this.appraisals !== null, last_results: this.results.at(-1) ?? null,
      standings: this.standings(), salvage_ratio: rules.salvage_ratio };
  }

  log(method, path, detail = '') {
    this.events.push({ at: new Date().toISOString(), method, path, detail });
    if (this.events.length > 150) this.events.shift();
  }

  appraise(items) {
    if (this.phase !== 'APPRAISAL') fail(409, 'NOT_APPRAISAL', 'Appraisal is closed.');
    if (this.appraisals) fail(409, 'ALREADY_SUBMITTED', 'Appraisal has already been submitted.');
    if (!Array.isArray(items) || !items.length) fail(422, 'INVALID_ITEMS', 'Send appraisal items.');
    const existing = new Set();
    for (const item of items) {
      if (!this.lots.some(l => l.lot_id === item?.lot_id) || existing.has(item.lot_id)
          || !Number.isFinite(item.est_value_per_kg) || item.est_value_per_kg <= 0) {
        fail(422, 'INVALID_APPRAISAL', 'Use unique lot IDs and positive values.');
      }
      existing.add(item.lot_id);
    }
    this.appraisals = items;
    return { items };
  }

  validate(item, current) {
    if (!item || typeof item !== 'object') fail(422, 'INVALID_OFFER', 'Offer must be an object.');
    const { lot_id, rfq_id, kg, price_per_kg } = item;
    const lot = this.lots.find(l => l.lot_id === lot_id);
    const rfq = this.rfqs.find(r => r.rfq_id === rfq_id);
    if (!lot || !rfq) fail(404, 'UNKNOWN_LOT_OR_RFQ', 'Choose a lot and an RFQ from the open round.');
    if (!Number.isInteger(kg) || kg <= 0 || kg % BAG) fail(422, 'INVALID_KG', 'Use multiples of 60 kg.');
    if (!Number.isFinite(price_per_kg) || price_per_kg <= 0 || price_per_kg > 1000) {
      fail(422, 'INVALID_PRICE', 'Price must be above 0 and at most 1000.');
    }
    if (kg > rfq.kg) fail(422, 'RFQ_LIMIT', 'Offer quantity exceeds the RFQ size.');
    const sum = entries => entries.reduce((total, o) => total + o.kg, 0);
    if (kg + sum(current.filter(o => o.lot_id === lot_id)) > lot.kg_remaining) {
      fail(422, 'NOT_ENOUGH_KG', 'Offer exceeds the available lot quantity.');
    }
    if (kg + sum(current) > this.state().round_capacity_kg) {
      fail(422, 'CAPACITY_EXCEEDED', 'Offer exceeds the round capacity.');
    }
    return { lot_id, rfq_id, kg, price_per_kg: round(price_per_kg) || price_per_kg };
  }

  submit(items, replace, batch) {
    this.requireOpen();
    if (!Array.isArray(items)) fail(422, 'INVALID_OFFERS', 'Send an offers array.');
    const next = replace ? [] : [...this.offers];
    const first = next.length;
    for (const [index, item] of items.entries()) {
      try {
        next.push(this.validate(item, next));
      } catch (error) {
        if (!batch || !error.code) throw error;
        fail(422, 'BATCH_REJECTED', 'No offers were saved.', { errors: [{ index, code: error.code }] });
      }
    }
    for (let i = first; i < next.length; i++) {
      Object.assign(next[i], { offer_id: `O${++this.serial}`, round_id: calendar[this.roundIndex].round_id, status: 'OPEN' });
    }
    this.offers = next;
    return next.slice(first);
  }

  requireOpen() {
    if (this.phase !== 'ROUND_OPEN') fail(409, 'ROUND_NOT_OPEN', 'The round is closed for offers.');
  }

  change(id, patch, remove) {
    this.requireOpen();
    const prior = this.offers.find(o => o.offer_id === id);
    if (!prior) fail(404, 'UNKNOWN_OFFER', 'Offer not found.');
    const remaining = this.offers.filter(o => o !== prior);
    if (remove) {
      this.offers = remaining;
      return { ...prior, status: 'CANCELLED' };
    }
    const { kg = prior.kg, price_per_kg = prior.price_per_kg } = patch ?? {};
    const changed = { ...prior, ...this.validate({ ...prior, kg, price_per_kg }, remaining) };
    this.offers = this.offers.map(o => o === prior ? changed : o);
    return changed;
  }

  advance() {
    switch (this.phase) {
      case 'WAITING': this.phase = 'SETUP'; break;
      case 'SETUP': this.phase = 'APPRAISAL'; break;
      case 'APPRAISAL': this.openRound(); break;
      case 'ROUND_OPEN': this.clearRound(); this.phase = 'ROUND_CLEARING'; break;
      case 'ROUND_CLEARING':
        if (this.roundIndex === rules.timeline.rounds) this.phase = 'CLOSED';
        else this.openRound();
        break;
      default: fail(409, 'MARKET_CLOSED', 'Reset to run another demo.');
    }
  }

  openRound() {
    this.roundIndex++;
    const number = this.roundIndex;
    this.phase = 'ROUND_OPEN';
    this.offers = [];
    this.rfqs = buyerTypes.map(({ buyer, buyer_type, cutoff, spec }, i) => {
      const peak = number >= 6 && number <= 8 && buyer_type === 'SPECIALTY';
      const bags = (number >= 13 ? 1 : peak ? 6 : 3) + Math.floor(this.rand() * 4);
      return { rfq_id: `${calendar[number].round_id}-0${i + 1}`, buyer, buyer_type, bags, kg: bags * BAG,
        spec: { max_defect_pct: spec[0], max_moisture_pct: spec[1], min_screen: spec[2] },
        cutoff: cutoff + (this.rand() - 0.5) * 0.065,
        competing: { ratio: cutoff - 0.065 + this.rand() * 0.05, kg: Math.floor(this.rand() * (bags + 1)) * BAG } };
    });
  }

  clearRound() {
    const period = calendar[this.roundIndex];
    const my_offers = this.offers.map(o => ({ ...o, filled_kg: 0 }));
    const market_summary = this.rfqs.map(({ cutoff, competing, spec, kg, rfq_id, buyer, buyer_type }) => {
      const offers = my_offers.filter(o => o.rfq_id === rfq_id);
      const eligible = [];
      for (const offer of offers) {
        const lot = this.lots.find(l => l.lot_id === offer.lot_id);
        const ratio = offer.price_per_kg / lot.tv;
        if (!meets(lot.truth, spec)) offer.status = 'SPEC_MISMATCH';
        else if (ratio > cutoff) offer.status = 'ABOVE_LIMIT';
        else eligible.push({ offer, lot, ratio, remaining: offer.kg });
      }
      if (competing.kg) eligible.push({ ratio: competing.ratio, remaining: competing.kg });
      eligible.sort((a, b) => a.ratio - b.ratio);
      let capacity = kg;
      for (const [index, bid] of eligible.entries()) {
        if (index && eligible[index - 1].ratio === bid.ratio) continue;
        const ties = eligible.filter(candidate => candidate.ratio === bid.ratio);
        while (capacity && ties.some(candidate => candidate.remaining)) {
          for (const candidate of ties) {
            if (!capacity || !candidate.remaining) continue;
            candidate.remaining -= BAG;
            capacity -= BAG;
            if (candidate.offer) candidate.offer.filled_kg += BAG;
          }
        }
      }
      for (const { offer, lot } of eligible.filter(bid => bid.offer)) {
        offer.status = offer.filled_kg === offer.kg ? 'ACCEPTED' : offer.filled_kg ? 'PARTIAL' : 'OUTBID';
        if (period.counts_for_score) {
          lot.kg_remaining -= offer.filled_kg;
          this.revenue += offer.filled_kg * offer.price_per_kg;
        }
      }
      const filled = offers.filter(o => o.filled_kg > 0);
      const sold = filled.reduce((sum, o) => sum + o.filled_kg, 0);
      return { rfq_id, buyer, buyer_type, wanted_kg: kg, bought_kg: kg - capacity,
        offers: offers.length + Number(competing.kg > 0), price_min: sold ? Math.min(...filled.map(o => o.price_per_kg)) : null,
        price_max: sold ? Math.max(...filled.map(o => o.price_per_kg)) : null,
        price_avg: sold ? round(filled.reduce((sum, o) => sum + o.filled_kg * o.price_per_kg, 0) / sold) : null };
    });
    this.results.push({ round_id: period.round_id, kind: period.kind, my_offers, market_summary });
  }

  reveal() {
    if (this.phase !== 'CLOSED') fail(409, 'MARKET_NOT_CLOSED', 'True values are revealed after closing.');
    const total_tv_thb = round(this.lots.reduce((sum, l) => sum + l.kg_total * l.tv, 0));
    const salvage_thb = round(rules.salvage_ratio * this.lots.reduce((sum, l) => sum + l.kg_remaining * l.tv, 0));
    const appraisal_error = this.lots.reduce((sum, l) => {
      const item = this.appraisals?.find(a => a.lot_id === l.lot_id);
      return sum + (item ? Math.abs(item.est_value_per_kg / l.tv - 1) : 1);
    }, 0) / this.lots.length;
    return { ...this.standings(), total_tv_thb, salvage_thb, pr: (this.revenue + salvage_thb) / total_tv_thb,
      appraisal_error, appraisal_points: round(20 * Math.max(0, 1 - appraisal_error / 0.1)),
      lots: this.lots.map(l => ({ lot_id: l.lot_id, true_value_per_kg: l.tv, quality: l.truth })) };
  }
}

module.exports = { DemoMarket, calendar, rules, fail };
