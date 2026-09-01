import type { HelpArticle } from '@/types/help';

const ex = (article: HelpArticle): HelpArticle => article;

/**
 * Help for the Special Trading Days page.
 *
 * The concept needs more explanation than most fields on this page, because
 * what it does depends on what the *other* two tables say — the venue's
 * weekend days and its holidays. Every claim here was checked against the
 * engine's own calendar rather than written from the field names.
 */
export const specialTradingDaysHelpContent: Record<string, HelpArticle> = {
  'specialTradingDays.overview': ex({
    fieldKey: 'specialTradingDays.overview',
    title: 'Special Trading Days',
    category: 'Overview',
    description: [
      'A special trading day **opens** a day that the exchange would otherwise be closed on. It is the only thing that can override a weekend or a holiday, and it does so for **one exchange on one date** — never for the others.',
      'Two questions decide what a row does:',
      '**1. Why would the day be closed?** Because it is a weekend, or because it is in the Holidays table. A special trading day beats both.',
      '**2. Does the exchange keep its usual hours that day?** If yes, leave Market Open and Market Close empty. If it trades a shorter or shifted session, fill them in.',
      'Nothing else changes. Square-off offsets, algo start, the pre-open auction and every other timing on the Exchanges page are measured from the session this row defines, so a shortened session shortens them with it.',
    ],
    example: {
      title: 'How the engine decides whether a day is open',
      content:
        'For one exchange and one date, in this order:\n\n`1.` Is there a **special trading day**? → **open**, using its hours if set, otherwise the exchange\'s usual hours.\n`2.` Is the date in **Holidays**? → closed.\n`3.` Is the weekday one of the exchange\'s **weekend days**? → closed.\n`4.` Otherwise → open, usual hours.\n\nStep 1 comes first, which is what makes the rest of this page possible.',
    },
    warning:
      'Holidays and special trading days are both per exchange. A holiday on NSE says nothing about MCX, and neither does a special trading day.',
    relatedFields: [
      'specialTradingDays.budgetOnSaturday',
      'specialTradingDays.mcxEvening',
      'specialTradingDays.muhurat',
      'specialTradingDays.marketOpen',
    ],
  }),

  'specialTradingDays.budgetOnSaturday': ex({
    fieldKey: 'specialTradingDays.budgetOnSaturday',
    title: 'Case 1 — a full session on a weekend',
    category: 'Cases',
    description: [
      'The Union Budget is presented on a Saturday and the exchange holds a **normal** trading day for it. Without a row here the engine sees a Saturday, finds it in the exchange\'s weekend days, and stays out of the market entirely.',
      'Leave both hour fields **empty**. The exchange trades its usual session, so the row only needs to say *that this date is open*.',
    ],
    example: {
      title: 'Budget on Saturday 31-Jan-2026, NSE trading 09:15–15:40',
      content:
        'Exchange: `NSE`\nDate: `2026-01-31`\nTrading Day Name: `Union Budget`\nMarket Open: *(empty)*\nMarket Close: *(empty)*\n\nThe engine then reports that Saturday open 09:15–15:40 — the exchange\'s own hours — while every other Saturday stays shut.',
    },
    relatedFields: [
      'specialTradingDays.mcxEvening',
      'specialTradingDays.muhurat',
      'specialTradingDays.marketOpen',
    ],
  }),

  'specialTradingDays.mcxEvening': ex({
    fieldKey: 'specialTradingDays.mcxEvening',
    title: 'Case 2 — one exchange open while the others are shut',
    category: 'Cases',
    description: [
      'A national holiday closes NSE and BSE for the whole day, but MCX runs its **evening session** anyway. This is the common shape of an Indian commodity holiday: the morning is shut, the evening is not.',
      'Because holidays are per exchange, this needs the two tables used together **on MCX only**:',
      '**a.** A row in **Holidays** for MCX on that date — that is what closes the morning session it would otherwise trade.',
      '**b.** A row here for MCX on the same date, with Market Open and Market Close set to the evening window.',
      'NSE and BSE need nothing: their own holiday rows already close them, and neither of the MCX rows touches them.',
    ],
    example: {
      title: 'Holi, 03-Mar-2026 — MCX evening only',
      content:
        'Holidays → `MCX` `2026-03-03` "Holi (morning closed)"\nSpecial Trading Days → `MCX` `2026-03-03` "Holi evening session", `17:00`–`23:30`\n\nThe engine then reports, for that date:\n\n`NSE` closed all day\n`BSE` closed all day\n`MCX` open **17:00–23:30** — shut at 10:00, trading at 19:00',
    },
    warning:
      'The Holidays row is the half that is easy to forget. Without it MCX has no holiday on that date, so the engine believes it trades its full usual session — 09:00 onwards — and the special trading day changes nothing, because the day was never closed to begin with.',
    relatedFields: [
      'specialTradingDays.muhurat',
      'specialTradingDays.budgetOnSaturday',
      'specialTradingDays.marketOpen',
    ],
  }),

  'specialTradingDays.muhurat': ex({
    fieldKey: 'specialTradingDays.muhurat',
    title: 'Case 3 — a short session on a holiday',
    category: 'Cases',
    description: [
      'Diwali muhurat trading: the date is a holiday for the exchange, and it also holds a ceremonial session of about an hour in the evening.',
      'The Holidays row stays. Add a row here with the muhurat window as its hours — a special trading day wins over a holiday, so the session is what the engine sees.',
    ],
    example: {
      title: 'Diwali muhurat',
      content:
        'Holidays → `NSE` `2026-11-08` "Diwali"  *(left in place)*\nSpecial Trading Days → `NSE` `2026-11-08` "Diwali Muhurat", `18:15`–`19:15`\n\nThe engine reports that date open 18:15–19:15 only. At 10:00 it is closed.',
    },
    relatedFields: [
      'specialTradingDays.mcxEvening',
      'specialTradingDays.budgetOnSaturday',
      'specialTradingDays.marketOpen',
    ],
  }),

  'specialTradingDays.exchange': ex({
    fieldKey: 'specialTradingDays.exchange',
    title: 'Exchange',
    category: 'Fields',
    description: [
      'Which exchange this date is open for, and **only** that exchange. To open the same date on several, add a row for each.',
      'The exchange must already exist on the Exchanges page. A row against a code that does not is refused, because the engine looks these up by exchange and one that matches nothing would be silently ignored — leaving the day closed while the table says otherwise.',
    ],
  }),

  'specialTradingDays.tradingDate': ex({
    fieldKey: 'specialTradingDays.tradingDate',
    title: 'Date',
    category: 'Fields',
    description: [
      'The single date this row opens. There is no range: a two-day event is two rows.',
      'One row per exchange and date. Adding the same pair twice is refused rather than overwriting, so an existing row has to be edited or deleted deliberately.',
    ],
    example: { title: 'Format', content: '`YYYY-MM-DD` — for example `2026-01-31`.' },
  }),

  'specialTradingDays.tradingDayName': ex({
    fieldKey: 'specialTradingDays.tradingDayName',
    title: 'Trading Day Name',
    category: 'Fields',
    description: [
      'A label for people, not for the engine. Nothing branches on it.',
      'Worth writing anyway: in a year you will want to know why a Saturday was open, and "Union Budget" answers that where a bare date does not.',
    ],
    example: {
      title: 'Useful names',
      content: '`Union Budget`\n`Diwali Muhurat`\n`Holi evening session`\n`Special live trading session`',
    },
  }),

  'specialTradingDays.marketOpen': ex({
    fieldKey: 'specialTradingDays.marketOpen',
    title: 'Market Open and Market Close',
    category: 'Fields',
    description: [
      'The session this date trades, when it differs from the exchange\'s usual one.',
      '**Leave both empty** and the exchange\'s own Market Open and Market Close apply — that is the right answer for a normal session held on a weekend.',
      '**Fill both in** and they replace the usual hours for this date only: an evening-only commodity session, a muhurat hour, a shortened half-day.',
      'It has to be both or neither. One alone is refused — a single time cannot describe a session, and falling back silently to the usual hours would look like the entry had been ignored.',
    ],
    defaultValue: 'Empty — the exchange\'s usual hours',
    example: {
      title: 'Both forms',
      content:
        '*Usual hours* — Budget on a Saturday:\nMarket Open: *(empty)*  Market Close: *(empty)*\n\n*Own hours* — MCX evening session:\nMarket Open: `17:00`  Market Close: `23:30`',
    },
    warning:
      'These are wall-clock times in the exchange\'s own timezone, exactly like the hours on the Exchanges page. They are not UTC and are not converted.',
  }),
};
