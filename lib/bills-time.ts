/** How long a payment needs, at the least, to get from the treasury to a provider's deposit address: below this a provider order is not worth sending. */
export const MIN_MINUTES_TO_PAY = 3;
/** How long a provider such as Bitrefill holds an order's price when it does not say. */
export const BILL_WINDOW_MINUTES = 15;
