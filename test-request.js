fetch('http://localhost:3000/api/escrow/create-payment-intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ amount: 5000, currency: 'inr', sessionId: 'sess_123' }),
})
  .then(res => res.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));