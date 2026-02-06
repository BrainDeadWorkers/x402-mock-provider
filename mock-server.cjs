/**
 * Mock x402 provider for demo purposes
 * 
 * For hackathon demo: Always accepts requests and returns mock payment verification.
 * In production, use real x402 middleware for payment verification.
 */
const express = require("express");

const app = express();
app.use(express.json());

const PROVIDER_WALLET = process.env.PROVIDER_WALLET || "0xe08Ad6b0975222f410Eb2fa0e50c7Ee8FBe78F2D";
const PRICE = "$0.01";
const NETWORK = "eip155:84532";

// CORS headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment, X-Payment-Signature");
  res.setHeader("Access-Control-Expose-Headers", "X-Payment, X-Payment-Response");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Fulfill endpoint - always accepts for demo
app.post("/fulfill", (req, res) => {
  try {
    const body = req.body || {};
    const intentId = body.intentId || "unknown";
    const input = body.input;
    
    // Check if payment header was provided (for logging)
    const xPayment = req.headers["x-payment"];
    console.log(`Fulfill request: intentId=${intentId}, hasPayment=${!!xPayment}`);
    
    // Generate mock transaction hash
    const mockTxHash = "0x" + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join("");
    
    // Generate result
    const preview = typeof input === "string" ? input.substring(0, 50) : JSON.stringify(input || {}).substring(0, 50);
    const result = `Fulfilled intent ${intentId}: ${preview}...`;
    
    // Set payment response header (mock settlement)
    const paymentResponse = {
      success: true,
      transaction: mockTxHash,
      network: NETWORK,
      amount: PRICE
    };
    res.setHeader("X-Payment-Response", Buffer.from(JSON.stringify(paymentResponse)).toString("base64"));
    
    res.json({
      success: true,
      intentId,
      result,
      timestamp: new Date().toISOString(),
      payment: {
        status: "verified",
        txHash: mockTxHash,
        network: NETWORK,
        amount: PRICE,
        payTo: PROVIDER_WALLET
      }
    });
  } catch (err) {
    console.error("Error in /fulfill:", err);
    res.status(500).json({ error: "Internal error", message: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    x402: true,
    mock: true,
    demo: true,
    payTo: PROVIDER_WALLET 
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Mock x402 provider on http://localhost:" + PORT);
  console.log("Payments to: " + PROVIDER_WALLET);
  console.log("Mode: DEMO (always accepts)");
});
