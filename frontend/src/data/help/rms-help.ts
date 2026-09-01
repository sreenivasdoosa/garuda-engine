import type { HelpArticle } from '@/types/help';

const rms = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const rmsHelpContent: Record<string, HelpArticle> = {
  // ==================== PRICE VALIDATION ====================

  'rms.stalePriceSeconds': rms({
    fieldKey: 'rms.stalePriceSeconds',
    title: 'Stale Price (seconds)',
    category: 'Price Validation',
    description: [
      'Maximum age (in seconds) of the last traded price before it is considered **stale**. Orders are rejected if the most recent trade on the instrument is older than this threshold.',
      'This prevents the system from placing orders based on outdated market data — for example, if the feed is delayed or an illiquid option has not traded recently.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `300` (5 min). A NIFTY 18000 CE option last traded at 10:15:00 AM. At 10:20:30 AM, the strategy tries to place an order. The RMS rejects it because the price is 330 seconds old (> 300 sec threshold).',
    },
    defaultValue: 'null (no stale price check)',
    relatedFields: ['rms.earlyMarketGraceSeconds', 'rms.minVolumeToday'],
    warning:
      'Setting this too low (e.g. 30 sec) can cause frequent rejections on illiquid instruments like deep OTM options.',
  }),

  'rms.earlyMarketGraceSeconds': rms({
    fieldKey: 'rms.earlyMarketGraceSeconds',
    title: 'Early Market Grace (seconds)',
    category: 'Price Validation',
    description: [
      'Number of seconds after market open during which the **stale price check is skipped**. This grace period accounts for the fact that many instruments — especially options — may not have traded yet in the opening period.',
      'Without this, strategies that trade at market open would be blocked on instruments that simply haven\'t printed a trade yet.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Market opens at 9:15 AM. Grace set to `600` (10 min). Until 9:25 AM, orders are allowed even if the last trade was from the previous day. After 9:25, the `stalePriceSeconds` check kicks in.',
    },
    defaultValue: 'null (grace period disabled)',
    relatedFields: ['rms.stalePriceSeconds', 'rms.minVolumeEarlyMarket'],
  }),

  'rms.minVolumeToday': rms({
    fieldKey: 'rms.minVolumeToday',
    title: 'Min Volume Today',
    category: 'Price Validation',
    description: [
      'Minimum cumulative traded volume that an instrument must have for the current day before the system will allow orders. This filters out instruments with very low liquidity.',
      'Low-volume instruments have wide spreads and unreliable prices, making them risky to trade algorithmically.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `1000`. A BANKNIFTY 45000 PE has only 200 contracts traded today. The RMS blocks the order. Once volume crosses 1000, orders are allowed.',
    },
    defaultValue: 'null (no volume check)',
    relatedFields: ['rms.minVolumeEarlyMarket', 'rms.stalePriceMinutes', 'rms.minDepthQuantity'],
  }),

  'rms.minVolumeEarlyMarket': rms({
    fieldKey: 'rms.minVolumeEarlyMarket',
    title: 'Min Volume Early Market',
    category: 'Price Validation',
    description: [
      'Separate (usually lower) minimum volume threshold applied during the first few minutes of market open. This is a relaxed version of `minVolumeToday` for the opening session.',
      'At market open, cumulative volume is naturally low. This prevents the regular volume check from blocking all early trades.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Regular `minVolumeToday` is `1000`, but `minVolumeEarlyMarket` is `50`. In the first 5 minutes, only 50 contracts need to have traded for orders to be allowed.',
    },
    defaultValue: 'null (uses minVolumeToday for all times)',
    relatedFields: ['rms.minVolumeToday', 'rms.earlyMarketGraceSeconds', 'rms.minVolumeEarlyPeriodSeconds'],
  }),

  'rms.minVolumeEarlyPeriodSeconds': rms({
    fieldKey: 'rms.minVolumeEarlyPeriodSeconds',
    title: 'Min Volume Early Period (seconds)',
    category: 'Price Validation',
    description: [
      'Duration (in seconds) after market open during which the **relaxed early market volume threshold** (`minVolumeEarlyMarket`) is applied instead of `minVolumeToday`.',
      'This is separate from the Early Market Grace period (which controls stale price check skipping). You can configure different windows for stale price grace and volume relaxation.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `300` (5 min). Market opens at 9:15 AM. Until 9:20 AM, the `minVolumeEarlyMarket` threshold is used. After 9:20 AM, the stricter `minVolumeToday` threshold applies. Meanwhile, the Early Market Grace (for stale price) can be set independently to 600 sec (10 min).',
    },
    defaultValue: 'null (defaults to 300 seconds / 5 min)',
    relatedFields: ['rms.minVolumeEarlyMarket', 'rms.minVolumeToday', 'rms.earlyMarketGraceSeconds'],
  }),

  'rms.minOpenInterest': rms({
    fieldKey: 'rms.minOpenInterest',
    title: 'Min Open Interest',
    category: 'Price Validation',
    description: [
      'Minimum open interest (OI) required for an instrument before orders are allowed. Applicable for **OPTIONS segment only**.',
      'Low OI indicates that very few contracts are outstanding, meaning the instrument is illiquid. Trading such instruments carries higher slippage risk and may result in difficulty exiting positions.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `10000`. A far OTM NIFTY option has OI of 500. The RMS rejects the order because 500 < 10000. Once OI builds up past 10000 (indicating sufficient market participation), orders are allowed.',
    },
    defaultValue: 'null (no OI check)',
    relatedFields: ['rms.minVolumeToday', 'rms.minDepthQuantity'],
    warning:
      'OI data depends on the broker feed providing the `oi` field in quotes. If OI is not available (shows as 0), this check will block all orders — set only if your feed reliably provides OI.',
  }),

  'rms.maxBidAskSpreadPct': rms({
    fieldKey: 'rms.maxBidAskSpreadPct',
    title: 'Max Bid-Ask Spread %',
    category: 'Price Validation',
    description: [
      'Maximum allowed percentage spread between the best bid and best ask prices. Orders are rejected if the spread exceeds this value.',
      'A wide spread indicates poor liquidity or volatile conditions. Trading into a wide spread means immediate slippage and potential losses.',
      'Calculated as: `(ask - bid) / midPrice * 100`',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `5.0`. Bid = 95, Ask = 105, Mid = 100. Spread = 10%. Order is rejected because 10% > 5%. If Ask drops to 100, spread = 5%, order is allowed.',
    },
    defaultValue: 'null (no spread check)',
    relatedFields: ['rms.maxBidAskSpreadAbsolute', 'rms.bidAskAbsoluteThresholdPrice'],
    warning:
      'For low-priced options (e.g. Rs 2-5), percentage spread can be very high even with a Re 1 gap. Use `maxBidAskSpreadAbsolute` for those cases.',
  }),

  'rms.maxBidAskSpreadAbsolute': rms({
    fieldKey: 'rms.maxBidAskSpreadAbsolute',
    title: 'Max Spread Absolute',
    category: 'Price Validation',
    description: [
      'Maximum allowed absolute difference (in price points) between bid and ask. This is used **instead of** the percentage spread check for low-priced instruments.',
      'When an instrument\'s price is below `bidAskAbsoluteThresholdPrice`, this absolute spread limit applies instead of the percentage-based one.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Threshold price = `10`, absolute spread = `2.0`. A deep OTM option priced at Rs 3 has Bid = 2.5, Ask = 4.0 (spread = 1.5). Allowed because 1.5 < 2.0. If Ask were 5.0 (spread = 2.5), it would be rejected.',
    },
    defaultValue: 'null (no absolute spread check)',
    relatedFields: ['rms.maxBidAskSpreadPct', 'rms.bidAskAbsoluteThresholdPrice'],
  }),

  'rms.bidAskAbsoluteThresholdPrice': rms({
    fieldKey: 'rms.bidAskAbsoluteThresholdPrice',
    title: 'Absolute Threshold Price',
    category: 'Price Validation',
    description: [
      'The price below which the system switches from **percentage-based** spread check to **absolute** spread check.',
      'This solves the problem where a Rs 0.50 spread on a Rs 5 option looks like 10% (seems wide), but is actually just 1 tick in absolute terms.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `10`. For instruments priced above Rs 10, `maxBidAskSpreadPct` (e.g. 5%) is used. For instruments priced at Rs 10 or below, `maxBidAskSpreadAbsolute` (e.g. Rs 2) is used instead.',
    },
    defaultValue: 'null (always use percentage spread)',
    relatedFields: ['rms.maxBidAskSpreadPct', 'rms.maxBidAskSpreadAbsolute'],
  }),

  'rms.minDepthQuantity': rms({
    fieldKey: 'rms.minDepthQuantity',
    title: 'Min Depth Quantity',
    category: 'Price Validation',
    description: [
      'Minimum total quantity required across the visible order book depth levels. This ensures there is enough liquidity in the book before placing an order.',
      'Even if the spread looks tight, a thin book (few lots at each level) means large orders can cause significant slippage.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `500`. The top 5 bid levels show quantities of 50, 100, 80, 30, 40 = 300 total. Order is rejected (300 < 500). Once more orders appear in the book, trades are allowed.',
    },
    defaultValue: 'null (no depth quantity check)',
    relatedFields: ['rms.minDepthLevels', 'rms.minVolumeToday'],
  }),

  'rms.minDepthLevels': rms({
    fieldKey: 'rms.minDepthLevels',
    title: 'Min Depth Levels',
    category: 'Price Validation',
    description: [
      'Minimum number of price levels that must be present in the order book. This ensures the book isn\'t extremely thin with orders at only 1-2 levels.',
      'A healthy order book has multiple price levels. An instrument with only 1 bid level could gap significantly if that order is consumed.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `3`. The bid side of an option only shows 2 price levels. The order is rejected. Once a third bid level appears, orders are allowed.',
    },
    defaultValue: 'null (no depth level check)',
    relatedFields: ['rms.minDepthQuantity', 'rms.minVolumeToday'],
  }),

  'rms.enableFreakPriceCheck': rms({
    fieldKey: 'rms.enableFreakPriceCheck',
    title: 'Enable Freak Price Check',
    category: 'Price Validation',
    description: [
      'When enabled, the system detects **abnormal price spikes** in the LTP (Last Traded Price) and rejects orders if the current price appears to be a freak trade.',
      'Freak trades occur when a market order hits a thin book, causing a single trade at an extremely high or low price. These are unreliable for algorithmic decisions.',
      'Particularly important for **options** where freak trades are more common due to lower liquidity in far strikes.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'A NIFTY 18500 CE normally trading at Rs 50 suddenly shows LTP of Rs 150 due to a freak trade. With this check enabled, the system recognizes the spike and rejects orders until the price normalizes.',
    },
    defaultValue: 'false (freak check disabled)',
    relatedFields: ['rms.freakCheckMinPrice', 'rms.maxBidAskSpreadPct'],
  }),

  'rms.freakCheckMinPrice': rms({
    fieldKey: 'rms.freakCheckMinPrice',
    title: 'Freak Check Min Price',
    category: 'Price Validation',
    description: [
      'The minimum instrument price above which the freak price check is applied. Below this price, freak detection is skipped.',
      'Very low-priced options (Rs 1-2) naturally have high percentage volatility. Applying freak detection to them would cause too many false positives.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `5.0`. An option priced at Rs 2 has wild swings (normal for that price level) — freak check is skipped. An option priced at Rs 50 that suddenly jumps to Rs 120 — freak check catches it.',
    },
    defaultValue: 'null (apply freak check to all prices)',
    relatedFields: ['rms.enableFreakPriceCheck'],
  }),

  // ==================== ORDER LIMITS ====================

  'rms.maxOrderQty': rms({
    fieldKey: 'rms.maxOrderQty',
    title: 'Max Qty Per Order',
    category: 'Order Limits',
    description: [
      'Maximum number of units (shares/contracts) allowed in a single order. Orders exceeding this quantity are rejected.',
      'This is a safety net against fat-finger errors or strategy bugs that try to place an abnormally large order.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `1800` for NIFTY options. A strategy tries to send an order for 2000 lots. The RMS rejects it as 2000 > 1800. The strategy would need to split into two orders.',
    },
    defaultValue: 'null (no per-order quantity limit)',
    relatedFields: ['rms.maxOrderQtyLots', 'rms.maxOrderValue', 'rms.enableFreezeQtyCheck'],
    warning:
      'This is raw quantity, not lots. For NIFTY options (lot size 25), set to `maxLots * 25`.',
  }),

  'rms.maxOrderQtyLots': rms({
    fieldKey: 'rms.maxOrderQtyLots',
    title: 'Max Lots Per Order',
    category: 'Order Limits',
    description: [
      'Maximum number of **lots** allowed in a single FnO order. The system divides the order quantity by the instrument\'s lot size and rejects if it exceeds this limit.',
      'Only applies to FnO instruments where lot size is defined. For equity orders, use `Max Qty Per Order` instead.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `36` for BANKNIFTY (lot size 15). An order for 40 lots (600 qty) is rejected because 40 > 36. An order for 30 lots (450 qty) is allowed.',
    },
    defaultValue: 'null (no lot-based limit)',
    relatedFields: ['rms.maxOrderQty', 'rms.maxOrderValue', 'rms.enableFreezeQtyCheck'],
  }),

  'rms.maxOrderValue': rms({
    fieldKey: 'rms.maxOrderValue',
    title: 'Max Value Per Order',
    category: 'Order Limits',
    description: [
      'Maximum value (Price x Quantity x Multiplier) allowed for a single order, in INR. For options and futures, the multiplier is the **lot size** — so the value is `premium x qty x lotSize`.',
      'This prevents large monetary exposure in a single order. It\'s especially useful as a second check alongside quantity limits.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `500000` (5 lakhs). A strategy tries to buy 1000 qty of a NIFTY option at Rs 600 (lot size 25). Order value = 600 x 1000 x 25 = Rs 1.5 Cr. Rejected because 1.5 Cr > 5 lakhs.',
    },
    defaultValue: 'null (no order value limit)',
    relatedFields: ['rms.maxOrderQty', 'rms.maxOrderQtyLots', 'rms.maxPriceDeviationPct'],
  }),

  'rms.maxPriceDeviationPct': rms({
    fieldKey: 'rms.maxPriceDeviationPct',
    title: 'Max Price Deviation %',
    category: 'Order Limits',
    description: [
      'Maximum allowed deviation of the order price from the current Last Traded Price (LTP), expressed as a percentage. Paired with **Max Price Deviation Abs (₹)** via OR — an order passes if EITHER the percentage or the absolute cap is within limit. Only orders that breach both get rejected.',
      'This catches orders with incorrect prices — whether from calculation errors, stale data, or bugs that produce extreme limit prices.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `5.0` with Abs cap `5.0`. LTP = ₹100, order at ₹108 (8% / ₹8) — both caps breached, rejected. LTP = ₹1.7, order at ₹2.45 (44% / ₹0.75) — abs cap (₹0.75 ≤ ₹5) wins, allowed. This avoids false rejections of legitimate aggressive MARKET→LIMIT rewrites on cheap options.',
    },
    defaultValue: '5.0',
    relatedFields: ['rms.maxPriceDeviationAbs', 'rms.maxOrderValue', 'rms.skipPriceValidationForExit'],
  }),

  'rms.maxPriceDeviationAbs': rms({
    fieldKey: 'rms.maxPriceDeviationAbs',
    title: 'Max Price Deviation Abs (₹)',
    category: 'Order Limits',
    description: [
      'Maximum allowed deviation of the order price from LTP in absolute rupees (|orderPrice − LTP|). Paired with **Max Price Deviation %** via OR — an order passes if EITHER cap is within limit.',
      'Necessary because percentage alone is a poor metric on cheap options: at LTP ₹1.7 a Re 1 fat-finger is 59% (rejected) while at LTP ₹500 a 5% deviation is ₹25 (still rejected) — different absolute risks treated the same. The absolute cap floors the rejection threshold so legitimate aggressive rewrites on cheap options pass while fat-fingers above the rupee threshold still get caught.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `5.0` with % cap `5.0`. LTP ₹1.7, order ₹2.45 → abs ₹0.75 (allowed via abs leg). LTP ₹100, order ₹103 → pct 3% (allowed via pct leg). LTP ₹100, order ₹110 → 10% AND ₹10, both exceed, rejected. LTP ₹50, order ₹57 → 14% AND ₹7, both exceed, rejected.',
    },
    defaultValue: '5.0',
    relatedFields: ['rms.maxPriceDeviationPct', 'rms.skipPriceValidationForExit'],
  }),

  'rms.maxOrdersPerSecond': rms({
    fieldKey: 'rms.maxOrdersPerSecond',
    title: 'Max Orders/Second',
    category: 'Order Limits',
    description: [
      'Maximum number of orders that can be submitted per second. This is primarily a **broker rate limit** safeguard — brokers typically allow 10-20 orders per second.',
      'Exceeding the broker\'s rate limit causes order rejections at the broker end, and repeated violations can lead to temporary API blocks.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `10`. In a single second, 12 order signals arrive. The first 10 are submitted; orders 11 and 12 are queued or rejected with a rate limit breach.',
    },
    defaultValue: '10 (typical broker rate limit)',
    relatedFields: ['rms.maxOrdersPerMinute', 'rms.maxOrdersPerDay'],
    warning:
      'Do not set higher than your broker\'s actual rate limit. Check with your broker for their specific limits.',
  }),

  'rms.maxOrderOperationsPerSecond': rms({
    fieldKey: 'rms.maxOrderOperationsPerSecond',
    title: 'Max Ops/Second',
    category: 'Order Limits',
    description: [
      'Maximum combined order operations per second across place, modify, and cancel calls for the same user-broker.',
      'Use this when the broker enforces a single API throttle across all order endpoints instead of only fresh placements.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `10`. In one second the system sends 4 fresh orders, 3 modifies, and 4 cancels. The first 10 operations are allowed and the 11th is rejected by RMS.',
    },
    defaultValue: '10 (copied from maxOrdersPerSecond for existing configs)',
    relatedFields: ['rms.maxOrdersPerSecond', 'rms.maxOrdersPerMinute', 'rms.maxOrdersPerDay'],
  }),

  'rms.maxOrdersPerMinute': rms({
    fieldKey: 'rms.maxOrdersPerMinute',
    title: 'Max Orders/Minute',
    category: 'Order Limits',
    description: [
      'Maximum number of orders allowed within any 1-minute rolling window. This provides a medium-term throttle to prevent runaway strategies.',
      'A strategy stuck in an error loop might rapidly place and cancel orders. This limit catches that pattern before the daily limit is hit.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `60`. A strategy rapidly places 65 orders within a minute (entry, exit, re-entry loop). After the 60th order, all subsequent orders in that minute are rejected.',
    },
    defaultValue: 'null (no per-minute limit)',
    relatedFields: ['rms.maxOrdersPerSecond', 'rms.maxOrdersPerDay', 'rms.maxRejectionRatePct'],
  }),

  'rms.maxOrdersPerDay': rms({
    fieldKey: 'rms.maxOrdersPerDay',
    title: 'Max Orders/Day',
    category: 'Order Limits',
    description: [
      'Total number of orders allowed for the entire trading day. Once this limit is reached, no more orders can be placed until the next trading day.',
      'This is the ultimate safety cap. Even if per-second and per-minute limits are not hit, a runaway system cannot exceed this daily total.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `500`. By 2:00 PM, a strategy has placed 498 orders. It can only place 2 more orders for the rest of the day. Any further orders are blocked.',
    },
    defaultValue: 'null (no daily order limit)',
    relatedFields: ['rms.maxOrdersPerSecond', 'rms.maxOrdersPerMinute', 'rms.maxOrdersPerSymbolPerDay'],
  }),

  'rms.enableFreezeQtyCheck': rms({
    fieldKey: 'rms.enableFreezeQtyCheck',
    title: 'Enable Freeze Qty Check',
    category: 'Order Limits',
    description: [
      'When enabled, validates order quantity against the exchange-defined **freeze quantity** limit. Orders exceeding the freeze quantity require manual exchange approval and cause delays.',
      'Each exchange defines freeze quantities per instrument. For NIFTY options, the freeze qty is typically 1800 units (72 lots). Orders above this trigger exchange-level scrutiny.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Enabled for NIFTY. Freeze qty = 1800. A strategy tries to place an order for 2000 qty. The RMS rejects it preemptively, avoiding the exchange freeze process. The strategy should split into two orders of 1000 each.',
    },
    defaultValue: 'false (freeze check disabled)',
    relatedFields: ['rms.maxOrderQty', 'rms.maxOrderQtyLots'],
    warning:
      'If disabled, orders exceeding freeze qty will still be placed but may get stuck in exchange review, causing execution delays.',
  }),

  'rms.skipPriceValidationForExit': rms({
    fieldKey: 'rms.skipPriceValidationForExit',
    title: 'Skip Price Validation for Exit',
    category: 'Order Limits',
    description: [
      'When enabled, **exit orders** (orders that close an existing position) bypass price validation checks like stale price, spread checks, and deviation limits.',
      'This is crucial for risk management — when you need to exit a position to cut losses, you should not be blocked by price quality checks. Getting out is more important than getting the perfect price.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'A strategy holds a short option position. The spread has widened to 15% (exceeding `maxBidAskSpreadPct` of 5%). With this flag enabled, the exit order goes through despite the wide spread. Without it, the exit would be blocked, leaving the position exposed.',
    },
    defaultValue: 'false (exit orders are validated normally)',
    relatedFields: ['rms.maxBidAskSpreadPct', 'rms.stalePriceMinutes', 'rms.maxPriceDeviationPct'],
    warning:
      'Recommended to enable this. Blocking exit orders due to price checks can lead to larger losses than accepting some slippage.',
  }),

  // ==================== POSITION LIMITS ====================

  'rms.maxOrdersPerSymbolPerDay': rms({
    fieldKey: 'rms.maxOrdersPerSymbolPerDay',
    title: 'Max Orders/Symbol/Day',
    category: 'Position Limits',
    description: [
      'Maximum number of orders allowed for a **single trading symbol** in one day. This prevents excessive churning on a particular instrument.',
      'Useful for catching strategies that repeatedly trade the same strike — each entry and exit counts as an order.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `50`. A strategy on NIFTY 18000 CE has placed 48 orders today (24 entries + 24 exits). It can only place 2 more orders on this specific instrument. Other symbols are unaffected.',
    },
    defaultValue: 'null (no per-symbol limit)',
    relatedFields: ['rms.maxOrdersPerDay', 'rms.maxBuyQtyPerSymbolPerDay', 'rms.maxSellQtyPerSymbolPerDay'],
  }),

  'rms.maxTotalPositions': rms({
    fieldKey: 'rms.maxTotalPositions',
    title: 'Max Total Positions',
    category: 'Position Limits',
    description: [
      'Maximum number of open positions allowed across **all symbols** simultaneously. New orders that would create a new position are rejected once this limit is reached.',
      'This controls overall portfolio exposure. Having too many open positions makes risk management difficult and increases margin requirements.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `10`. A user currently has 10 open positions (5 NIFTY strikes + 5 BANKNIFTY strikes). A new order for a FINNIFTY option (which would be position #11) is rejected. However, orders on existing positions (adjustments, exits) are still allowed.',
    },
    defaultValue: 'null (no position count limit)',
    relatedFields: ['rms.maxOrdersPerSymbolPerDay', 'rms.maxDailyLossAmount'],
  }),

  'rms.maxTotalCombos': rms({
    fieldKey: 'rms.maxTotalCombos',
    title: 'Max Total Combos',
    category: 'Position Limits',
    description: [
      'Maximum number of **multi-leg combos** open at once — a long/short pair, a covered call, and so on. A combo is counted once no matter how many legs it has.',
      'This is a **separate limit from Max Total Positions**, not a replacement, because the two count different things from different sources. Position count comes from the broker feed and bounds operational surface: orders, exits, rejects and margin lines, all of which a hedged straddle genuinely has four of. Combo count comes from the engine\'s own trade records and bounds structural risk.',
      'They cannot be merged. The broker position feed is keyed by symbol with a single net quantity and carries no combo identity, so two tranches on the same strike net into one row and the number of combos simply is not recoverable from it.',
      'A further leg joining a combo that is already counted is always allowed through — rejecting it would strand the earlier leg as a naked position, which is the exact outcome the limit exists to avoid.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `3`. Three long/short pairs are open — six broker positions. A fourth pair is rejected. The second leg of any of the three existing pairs is still allowed, so no pair is ever left one-sided by this limit.',
    },
    defaultValue: 'null (no combo count limit)',
    relatedFields: ['rms.maxTotalPositions'],
  }),

  'rms.maxBuyQtyPerSymbolPerDay': rms({
    fieldKey: 'rms.maxBuyQtyPerSymbolPerDay',
    title: 'Max Buy Qty/Symbol/Day',
    category: 'Position Limits',
    description: [
      'Maximum cumulative **buy quantity** for a single symbol in one trading day. This limits the total long exposure that can be built on any one instrument.',
      'This is cumulative — if you buy 100, sell 100, buy 100, your total buy qty is 200.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `5000` for NIFTY options. A strategy has bought a total of 4800 qty of NIFTY 18000 CE today. It can only buy 200 more of that specific instrument. Sells and buys of other instruments are unaffected.',
    },
    defaultValue: 'null (no buy quantity limit)',
    relatedFields: ['rms.maxSellQtyPerSymbolPerDay', 'rms.maxOrdersPerSymbolPerDay', 'rms.maxBuyOrdersPerDay'],
  }),

  'rms.maxSellQtyPerSymbolPerDay': rms({
    fieldKey: 'rms.maxSellQtyPerSymbolPerDay',
    title: 'Max Sell Qty/Symbol/Day',
    category: 'Position Limits',
    description: [
      'Maximum cumulative **sell quantity** for a single symbol in one trading day. This limits the total short exposure that can be built on any one instrument.',
      'Mirrors `maxBuyQtyPerSymbolPerDay` for the sell side. Especially important for **naked option selling** where risk is theoretically unlimited.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `3000` for BANKNIFTY options. A strategy has sold 2800 qty of BANKNIFTY 45000 PE. It can only sell 200 more. This limits the maximum naked short position size.',
    },
    defaultValue: 'null (no sell quantity limit)',
    relatedFields: ['rms.maxBuyQtyPerSymbolPerDay', 'rms.maxOrdersPerSymbolPerDay', 'rms.maxSellOrdersPerDay'],
    warning:
      'For option selling strategies, set this carefully. Naked short positions have unlimited risk and large quantities amplify that risk.',
  }),

  'rms.maxBuyOrdersPerDay': rms({
    fieldKey: 'rms.maxBuyOrdersPerDay',
    title: 'Max Buy Orders/Day',
    category: 'Position Limits',
    description: [
      'Maximum number of **buy orders** (not quantity — order count) allowed per day across all symbols. This limits how many buy transactions can be initiated.',
      'Helps control brokerage costs and prevents excessive position building throughout the day.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `200`. By midday, 195 buy orders have been placed. Only 5 more buy orders can be placed for the rest of the day. Sell orders are counted separately.',
    },
    defaultValue: 'null (no buy order count limit)',
    relatedFields: ['rms.maxSellOrdersPerDay', 'rms.maxOrdersPerDay', 'rms.maxBuyQtyPerSymbolPerDay'],
  }),

  'rms.maxSellOrdersPerDay': rms({
    fieldKey: 'rms.maxSellOrdersPerDay',
    title: 'Max Sell Orders/Day',
    category: 'Position Limits',
    description: [
      'Maximum number of **sell orders** allowed per day across all symbols. This limits how many sell transactions can be initiated.',
      'Often set to match or slightly exceed `maxBuyOrdersPerDay` to ensure exits are always possible.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `200`. A strategy has placed 198 sell orders today. It can only place 2 more sell orders. Important: ensure this is high enough that exit orders are never blocked.',
    },
    defaultValue: 'null (no sell order count limit)',
    relatedFields: ['rms.maxBuyOrdersPerDay', 'rms.maxOrdersPerDay', 'rms.maxSellQtyPerSymbolPerDay'],
    warning:
      'Setting this too low can prevent exit orders from being placed, leaving open positions unmanaged. Always set higher than your typical daily sell count.',
  }),

  'rms.maxPositionQtyPerSymbol': rms({
    fieldKey: 'rms.maxPositionQtyPerSymbol',
    title: 'Max Position Qty/Symbol',
    category: 'Position Limits',
    description: [
      'Maximum position quantity allowed per trading symbol. Validated against **live broker data** — checks current position from broker position cache plus all pending (unfilled) entry orders from the broker order book.',
      'Formula: `currentPosition + pendingEntryQty + newOrderQty <= maxPositionQtyPerSymbol`.',
      'Unlike daily quantity limits which track cumulative volume, this checks the **current state** — so if earlier positions have been exited, the capacity is freed up for new entries.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `5000`. Current LONG position = 2000, pending BUY orders = 2000. New BUY 1500: 2000+2000+1500 = 5500 > 5000 → **REJECTED**. New BUY 500: 2000+2000+500 = 4500 ≤ 5000 → ALLOWED.',
    },
    defaultValue: 'Futures: 5000, Options: 10000',
    relatedFields: ['rms.maxBuyQtyPerSymbolPerDay', 'rms.maxSellQtyPerSymbolPerDay', 'rms.maxOrdersPerSymbolPerDay'],
    warning:
      'Critical safety parameter — primary defense against bugs that fire duplicate entry signals. Validated against live broker order book data.',
  }),

  // ==================== LOSS PROTECTION ====================

  'rms.maxDailyLossAmount': rms({
    fieldKey: 'rms.maxDailyLossAmount',
    title: 'Max Daily Loss Amount',
    category: 'Loss Protection',
    description: [
      'Maximum allowed daily loss in **absolute INR amount**. Once the realized + unrealized P&L for the day falls below this negative threshold, new orders are blocked.',
      'This is the most critical RMS parameter. It defines the maximum drawdown per day. Works alongside `maxDailyLossPct` — whichever triggers first takes effect.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `50000` (Rs 50,000). A user\'s combined P&L drops to -Rs 48,000. They can still trade. Once it hits -Rs 50,000, all new orders are blocked. If `autoSquareOffOnBreach` is enabled, existing positions are also closed.',
    },
    defaultValue: 'null (no absolute loss limit)',
    relatedFields: ['rms.maxDailyLossPct', 'rms.autoSquareOffOnBreach', 'rms.enableAutoKillOnLoss'],
    warning:
      'At least one of `maxDailyLossAmount` or `maxDailyLossPct` should always be configured. Without loss limits, a single bad day can cause catastrophic losses.',
  }),

  'rms.maxDailyLossPct': rms({
    fieldKey: 'rms.maxDailyLossPct',
    title: 'Max Daily Loss %',
    category: 'Loss Protection',
    description: [
      'Maximum allowed daily loss as a **percentage of deployed capital**. This scales with the user\'s capital — larger accounts get proportionally larger loss limits.',
      'More flexible than absolute amounts because it auto-adjusts as capital changes. A user with Rs 10L deployed at 5% limit has a Rs 50,000 loss cap.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `3.0` (3%). User has Rs 10,00,000 deployed. Max loss = Rs 30,000. If their P&L drops to -Rs 30,000, new orders are blocked. If capital increases to Rs 20L, the limit automatically becomes Rs 60,000.',
    },
    defaultValue: 'null (no percentage loss limit)',
    relatedFields: ['rms.maxDailyLossAmount', 'rms.autoSquareOffOnBreach', 'rms.enableAutoKillOnLoss'],
  }),

  'rms.enableAutoKillOnLoss': rms({
    fieldKey: 'rms.enableAutoKillOnLoss',
    title: 'Auto Kill on Loss',
    category: 'Loss Protection',
    description: [
      'When enabled, the **kill switch** is automatically activated when a daily loss limit is breached. The kill switch blocks all new orders for that user/broker.',
      'The kill switch persists until manually deactivated by an admin. This prevents any automated recovery attempts from restarting trading.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Enabled with a Rs 1,00,000 daily loss limit. P&L hits -Rs 1,00,000. The kill switch activates automatically, blocking ALL trading. An admin must go to the Kill Switch tab and manually deactivate it before trading can resume.',
    },
    defaultValue: 'false (kill switch not triggered on loss)',
    relatedFields: ['rms.maxDailyLossAmount', 'rms.maxDailyLossPct', 'rms.autoSquareOffOnBreach'],
    warning:
      'Once activated, the kill switch requires **manual admin intervention** to deactivate. This means trading will be halted for the rest of the day unless an admin acts.',
  }),

  'rms.autoSquareOffOnBreach': rms({
    fieldKey: 'rms.autoSquareOffOnBreach',
    title: 'Auto Square-off on Breach',
    category: 'Loss Protection',
    description: [
      'When enabled, **all open positions are automatically closed** (squared off) when a loss limit is breached. This is an aggressive protective measure.',
      'Without this, breaching a loss limit only blocks **new** orders — existing positions remain open and losses can continue to grow. Enabling this ensures immediate risk reduction.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Enabled with `maxDailyLossAmount` = Rs 50,000. P&L hits -Rs 50,000. The system immediately places market exit orders for all open positions. New orders are also blocked. This limits the maximum loss for the day.',
    },
    defaultValue: 'false (only block new orders on breach)',
    relatedFields: ['rms.maxDailyLossAmount', 'rms.maxDailyLossPct', 'rms.enableAutoKillOnLoss'],
    warning:
      'Square-off uses market orders which may incur additional slippage in volatile conditions. However, the protection typically outweighs the slippage cost.',
  }),

  // ==================== CIRCUIT BREAKERS ====================

  'rms.maxRejectionRatePct': rms({
    fieldKey: 'rms.maxRejectionRatePct',
    title: 'Max Rejection Rate %',
    category: 'Circuit Breakers',
    description: [
      'Circuit breaker that triggers if the order rejection rate exceeds this percentage. A high rejection rate usually indicates a system issue — wrong prices, insufficient margin, or API problems.',
      'Calculated as: `(rejected orders / total orders) * 100` over a rolling window.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `30.0` (30%). Out of the last 100 orders, 35 were rejected. Rejection rate = 35%. Circuit breaker triggers, pausing all new orders. This usually indicates a connectivity or margin issue that needs investigation.',
    },
    defaultValue: 'null (no rejection rate circuit breaker)',
    relatedFields: ['rms.maxOrdersPerMinute', 'rms.enableAutoKillOnLoss'],
  }),

  'rms.maxVixLevel': rms({
    fieldKey: 'rms.maxVixLevel',
    title: 'Max VIX Level',
    category: 'Circuit Breakers',
    description: [
      'Maximum India VIX level above which all trading is paused. VIX measures market volatility expectations — a high VIX indicates extreme fear/uncertainty.',
      'During events like budget day, election results, or global crises, VIX can spike to 25-40+. Trading in such conditions carries significantly higher risk.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `25.0`. India VIX rises from 14 to 26 during a market crash. The circuit breaker activates, pausing all orders. Trading resumes when VIX drops back below 25 (after the `volatilityPauseMinutes` duration).',
    },
    defaultValue: 'null (no VIX-based circuit breaker)',
    relatedFields: ['rms.volatilityPauseMinutes', 'rms.enableAutoKillOnLoss'],
    warning:
      'VIX levels: 10-15 = calm market, 15-20 = normal, 20-25 = elevated, 25+ = high fear. Option premiums are significantly inflated during high VIX.',
  }),

  'rms.volatilityPauseMinutes': rms({
    fieldKey: 'rms.volatilityPauseMinutes',
    title: 'Volatility Pause Duration',
    category: 'Circuit Breakers',
    description: [
      'Duration (in minutes) for which trading is paused when a volatility-based circuit breaker (like `maxVixLevel`) triggers. After this period, the system re-checks the condition.',
      'This creates a cooling-off period. Rather than immediately resuming when VIX dips below the threshold, the system waits to ensure conditions have genuinely stabilized.',
    ],
    example: {
      title: 'Example Scenario',
      content:
        'Set to `15`. VIX hits 26 (above the `maxVixLevel` of 25). Trading pauses. After 15 minutes, the system checks VIX again. If it\'s back to 23, trading resumes. If still at 27, another 15-minute pause begins.',
    },
    defaultValue: 'null (no pause duration — instant resume when condition clears)',
    relatedFields: ['rms.maxVixLevel', 'rms.maxRejectionRatePct'],
  }),
};
