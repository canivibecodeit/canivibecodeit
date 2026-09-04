/* Reprice the sponsor board to the SLOT_SEED ladder.

   The seed in src/lib/db.js only ever sets a slot's price when its row is first
   created (ON CONFLICT DO NOTHING), so editing it changes nothing on a board
   that already exists. This applies the ladder to a live board instead.

   Dry run by default; --apply writes. Point it at whichever database you mean:
     node scripts/set-slot-prices.mjs                     # local SQLite, preview
     node scripts/set-slot-prices.mjs --apply             # local SQLite, write
     DATABASE_URL=... node scripts/set-slot-prices.mjs --apply   # production

   Live and held slots are skipped unless --force: a sponsor who has paid keeps
   the rate they bought, which is the promise the sponsor page makes. */
import { SLOT_SEED, activePurchases, setSlotPrice, sponsorSlots } from '../src/lib/db.js';

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

const usd = (cents) => `$${(cents / 100).toLocaleString('en-US')}`;

const slots = await sponsorSlots();
const current = new Map(slots.map((s) => [s.id, Number(s.price_cents)]));

// A slot with money against it is not repriced: that rate is committed.
const taken = new Set(
  (await activePurchases()).map((p) => p.slot_id).filter(Boolean)
);

let changed = 0;
let skipped = 0;

for (const [id, cents] of SLOT_SEED) {
  const now = current.get(id);
  if (now === undefined) {
    console.log(`${id}  (no row yet — the seed will create it at ${usd(cents)})`);
    continue;
  }
  if (now === cents) {
    console.log(`${id}  ${usd(now).padStart(7)}  unchanged`);
    continue;
  }
  if (taken.has(id) && !force) {
    console.log(`${id}  ${usd(now).padStart(7)}  SKIPPED · sold, keeps its rate (--force to override)`);
    skipped += 1;
    continue;
  }
  console.log(`${id}  ${usd(now).padStart(7)}  ->  ${usd(cents)}${apply ? '' : '   (dry run)'}`);
  if (apply) await setSlotPrice(id, cents);
  changed += 1;
}

console.log(
  `\n${apply ? 'applied' : 'would change'} ${changed} slot${changed === 1 ? '' : 's'}` +
    (skipped ? `, skipped ${skipped} sold` : '') +
    (apply ? '' : '\nre-run with --apply to write')
);
process.exit(0);
