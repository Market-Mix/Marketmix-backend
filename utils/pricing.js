// utils/pricing.js
const SELLER_FEE_PERCENT = 0.10;   // 10% platform fee, baked into listing price
const MIN_SELLER_PRICE   = 1500;   // minimum seller-intended payout

// Seller enters the amount they want to receive -> we markup for the buyer-facing price
function markupForListing(sellerPrice) {
  const base = parseFloat(sellerPrice);
  if (isNaN(base) || base < MIN_SELLER_PRICE) {
    const err = new Error(`Minimum product price is ₦${MIN_SELLER_PRICE.toLocaleString()}`);
    err.status = 400;
    throw err;
  }
  const listedPrice = Math.round(base * (1 + SELLER_FEE_PERCENT) * 100) / 100;
  return { basePrice: base, listedPrice };
}

// Strip the fee back out of what the buyer paid -> what the seller actually receives
function stripFee(amountPaid) {
  return Math.round((parseFloat(amountPaid) / (1 + SELLER_FEE_PERCENT)) * 100) / 100;
}

module.exports = { SELLER_FEE_PERCENT, MIN_SELLER_PRICE, markupForListing, stripFee };