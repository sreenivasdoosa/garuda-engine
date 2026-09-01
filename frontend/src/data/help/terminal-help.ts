import type { HelpArticle } from '@/types/help';

const th = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const terminalHelpContent: Record<string, HelpArticle> = {
  // ==================== TEST SIGNALS ====================

  'terminal.testSignal.strategy': th({
    fieldKey: 'terminal.testSignal.strategy',
    title: 'Strategy',
    category: 'Test Signals',
    description: [
      'The **strategy** to send the test signal to. Only strategies with `signalTriggerEnabled=true` are shown.',
      'Signals are produced by the strategy\'s own rules, evaluated in this engine against the instruments market data publishes.',
    ],
  }),

  'terminal.testSignal.tranch': th({
    fieldKey: 'terminal.testSignal.tranch',
    title: 'Tranch Number',
    category: 'Test Signals',
    description: [
      'The **tranch number** to target with this signal. Tranches are numbered starting from 1.',
    ],
    validValues: [
      '**0** — Auto-select the next un-signaled tranch',
      '**1-10** — Target a specific tranch number',
    ],
  }),

  'terminal.testSignal.action': th({
    fieldKey: 'terminal.testSignal.action',
    title: 'Action',
    category: 'Test Signals',
    description: [
      'The **type of signal** to send.',
    ],
    validValues: [
      '**ENTRY** — Trigger tranch execution via TranchScheduler',
      '**EXIT** — Close active trades via TradeManager',
    ],
  }),

  // ==================== RESET STRATEGY STATE ====================

  'terminal.resetState.username': th({
    fieldKey: 'terminal.resetState.username',
    title: 'Username',
    category: 'Reset Strategy State',
    description: [
      'The **username** whose strategy state will be reset. Must match the exact username in the system.',
    ],
    example: {
      title: 'Example',
      content: '"appa-zerodha", "amma-fyers"',
    },
    warning: 'This clears ALL state, signals, and trades for this user/strategy/broker combination.',
  }),

  'terminal.resetState.strategyName': th({
    fieldKey: 'terminal.resetState.strategyName',
    title: 'Strategy Name',
    category: 'Reset Strategy State',
    description: [
      'The **strategy name** to reset state for. Must match the exact internal strategy name.',
    ],
  }),

  'terminal.resetState.brokerName': th({
    fieldKey: 'terminal.resetState.brokerName',
    title: 'Broker Name',
    category: 'Reset Strategy State',
    description: [
      'The **broker name** to reset state for. Must match the exact broker code in the system.',
    ],
  }),

  'terminal.resetState.tradingDate': th({
    fieldKey: 'terminal.resetState.tradingDate',
    title: 'Trading Date',
    category: 'Reset Strategy State',
    description: [
      'The **trading date** to reset state for. Defaults to today. State is per-day — only the specified day\'s state is cleared.',
    ],
  }),

  // ==================== PLACE ORDER ====================

  'terminal.placeOrder.symbol': th({
    fieldKey: 'terminal.placeOrder.symbol',
    title: 'Trading Symbol',
    category: 'Place Order',
    description: [
      'The **broker-specific trading symbol** for the instrument. Must match exactly as the broker expects it.',
    ],
    example: {
      title: 'Example',
      content: '"NIFTY24JAN23000CE", "BANKNIFTY24JAN48000PE", "RELIANCE-EQ"',
    },
  }),

  'terminal.placeOrder.segment': th({
    fieldKey: 'terminal.placeOrder.segment',
    title: 'Segment',
    category: 'Place Order',
    description: [
      'The **market segment** for the order.',
    ],
    validValues: [
      '**EQUITY** — Cash/spot market',
      '**FNO** — Futures & Options',
      '**CURRENCY** — Currency derivatives',
      '**COMMODITY** — Commodity derivatives',
    ],
  }),

  'terminal.placeOrder.direction': th({
    fieldKey: 'terminal.placeOrder.direction',
    title: 'Direction',
    category: 'Place Order',
    description: [
      'The **order direction**.',
    ],
    validValues: [
      '**LONG** — Buy order',
      '**SHORT** — Sell order',
    ],
  }),

  'terminal.placeOrder.productType': th({
    fieldKey: 'terminal.placeOrder.productType',
    title: 'Product Type',
    category: 'Place Order',
    description: [
      'The **product type** determines margin requirements and auto-square-off behavior.',
    ],
    validValues: [
      '**MIS** — Margin Intraday Square-off (auto-squared off by broker at end of day)',
      '**NRML** — Normal F&O (carry-forward, full margin required)',
      '**CNC** — Cash & Carry delivery (equity delivery)',
    ],
  }),

  'terminal.placeOrder.orderType': th({
    fieldKey: 'terminal.placeOrder.orderType',
    title: 'Order Type',
    category: 'Place Order',
    description: [
      'The **order type** determines execution behavior.',
    ],
    validValues: [
      '**MARKET** — Execute at best available price immediately',
      '**LIMIT** — Execute at specified price or better (requires limit price)',
      '**SL-MARKET** — Stop-loss market order (requires trigger price)',
      '**SL-LIMIT** — Stop-loss limit order (requires both trigger and limit price)',
    ],
  }),

  // ==================== TERMINAL FILTERS ====================

  'terminal.filters.mismatch': th({
    fieldKey: 'terminal.filters.mismatch',
    title: 'Mismatch Filter',
    category: 'Terminal Filters',
    description: [
      'Show only users that have a **position mismatch** between the system\'s tracked positions and the broker\'s actual positions.',
      'Mismatches can occur due to manual trades on the broker platform, order failures, or connectivity issues.',
    ],
  }),

  'terminal.filters.active': th({
    fieldKey: 'terminal.filters.active',
    title: 'Active Filter',
    category: 'Terminal Filters',
    description: [
      'Show only users that have **active (open) trades** currently running.',
    ],
  }),

  'terminal.filters.online': th({
    fieldKey: 'terminal.filters.online',
    title: 'Online Filter',
    category: 'Terminal Filters',
    description: [
      'Show only users whose broker session is currently **logged in and connected**. Users who are not logged in cannot execute trades.',
    ],
  }),

  // ==================== HEDGE WINDOWS ====================

  'terminal.hedgeWindows.strategy': th({
    fieldKey: 'terminal.hedgeWindows.strategy',
    title: 'Strategy',
    category: 'Hedge Windows Recovery',
    description: [
      'The **strategy** to recover hedge windows for. Only strategies with hedge management enabled are applicable.',
    ],
  }),

  'terminal.hedgeWindows.windowType': th({
    fieldKey: 'terminal.hedgeWindows.windowType',
    title: 'Window Type',
    category: 'Hedge Windows Recovery',
    description: [
      'The **type of hedge window** to recover.',
    ],
    validValues: [
      '**ACTIVE** — Currently active hedge windows that need recovery',
      '**EXPIRED** — Expired hedge windows',
    ],
  }),

  // ==================== COMPLETE TRADE ====================

  'terminal.completeTrade.exitPrice': th({
    fieldKey: 'terminal.completeTrade.exitPrice',
    title: 'Exit Price',
    category: 'Complete Trade',
    description: [
      'The **price at which to record the trade exit**. This is used for manual trade completion when the broker order was handled outside the system.',
    ],
    warning: 'This manually marks the trade as complete. Use only when the actual broker-side position has already been closed.',
  }),

  'terminal.completeTrade.exitDate': th({
    fieldKey: 'terminal.completeTrade.exitDate',
    title: 'Exit Date',
    category: 'Complete Trade',
    description: [
      'The **date of the trade exit**. Only shown for positional (non-intraday) trades where the exit may occur on a different day than entry.',
    ],
  }),
};
