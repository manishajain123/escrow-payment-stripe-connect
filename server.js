require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

const escrowStore = new Map(); // key: orderId, value: { paymentIntentId, status, ... }

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    let event;
    try {
      console.log('webhook called');
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
 
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const orderId = pi.metadata.orderId;
      const order = escrowStore.get(orderId);
      if (order && order.status === 'pending') {
        order.status = 'held';
        order.chargeId = pi.latest_charge;
        console.log(`Order ${orderId} is now held in escrow`);
      }
    }
 
    if (event.type === 'account.updated') {
      const account = event.data.object;
      console.log(
        `Seller account ${account.id}: charges=${account.charges_enabled} payouts=${account.payouts_enabled}`
      );
      // In a real app, save these flags against the seller in your DB
    }
 
    res.json({ received: true });
  }
);


app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ---------------------------------------------------------------
// 1. Onboard a seller (connected account)
// ---------------------------------------------------------------
app.post('/seller/onboard', async (req, res) => {
  const { email } = req.body;
  try {
    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
 
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.APP_URL}/seller/refresh`,
      return_url: `${process.env.APP_URL}/seller/complete`,
      type: 'account_onboarding',
    });
 
    res.json({ sellerAccountId: account.id, onboardingUrl: accountLink.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---------------------------------------------------------------
// 2. Create escrow hold — buyer pays, funds sit on platform balance
// ---------------------------------------------------------------
app.post('/escrow/create', async (req, res) => {
  const { amount, currency = 'usd', orderId, sellerAccountId } = req.body;
 
  if (!amount || !orderId || !sellerAccountId) {
    return res.status(400).json({ error: 'amount, orderId, and sellerAccountId are required' });
  }
 
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      capture_method: 'automatic', // captures straight to platform balance
      metadata: { orderId, sellerAccountId },
    });
 
    escrowStore.set(orderId, {
      paymentIntentId: paymentIntent.id,
      sellerAccountId,
      amount,
      currency,
      status: 'pending',
    });
 
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.log(err,'err');
    res.status(500).json({ error: err.message });
  }
});
 
// ---------------------------------------------------------------
// 3. Release escrow — transfer held funds to the seller
// ---------------------------------------------------------------
app.post('/escrow/release', async (req, res) => {
  const { orderId } = req.body;
  const order = escrowStore.get(orderId);
 
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'held') {
    return res.status(400).json({ error: `Cannot release — status is '${order.status}'` });
  }
 
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: order.amount,
        currency: order.currency,
        destination: order.sellerAccountId,
        source_transaction: order.chargeId,
      },
      { idempotencyKey: `release_${order.paymentIntentId}` }
    );
 
    order.status = 'released';
    order.transferId = transfer.id;
 
    res.json({ transfer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---------------------------------------------------------------
// 4. Refund escrow — return held funds to the buyer
// ---------------------------------------------------------------
app.post('/escrow/refund', async (req, res) => {
  const { orderId } = req.body;
  const order = escrowStore.get(orderId);
 
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'held') {
    return res.status(400).json({ error: `Cannot refund — status is '${order.status}'` });
  }
 
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: order.paymentIntentId },
      { idempotencyKey: `refund_${order.paymentIntentId}` }
    );
 
    order.status = 'refunded';
    order.refundId = refund.id;
 
    res.json({ refund });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---------------------------------------------------------------
// 5. Check order/escrow status
// ---------------------------------------------------------------
app.get('/escrow/:orderId', (req, res) => {
  const order = escrowStore.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});
 

app.post('/api/escrow/create-payment-intent', async (req, res) => {
  const { amount, currency = 'inr', sessionId } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,              // smallest unit — paise for INR, cents for USD
      currency,
      capture_method: 'automatic', // captures into YOUR platform balance
      metadata: {
        sessionId: sessionId || '',
        escrowStatus: 'held',
      },
    });

    // TODO: save { sessionId, paymentIntentId: paymentIntent.id, amount, status: 'pending' } to your DB

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));