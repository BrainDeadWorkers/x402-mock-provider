/**
 * Mock x402 provider for demo purposes
 */
const express = require("express");

const app = express();
app.use(express.json());

const PROVIDER_WALLET = process.env.PROVIDER_WALLET || "0xe08Ad6b0975222f410Eb2fa0e50c7Ee8FBe78F2D";
const PRICE = "$0.01";
const NETWORK = "eip155:84532";

// Simulate x402 payment response
app.post("/fulfill", (req, res) => {
  try {
    const xPayment = req.headers["x-payment"];
    
    // If no payment header, return 402 with payment requirements
    if (!xPayment) {
      const paymentSpec = {
        accepts: [{
          scheme: "exact",
          network: NETWORK,
          maxAmountRequired: PRICE,
          resource: "/fulfill",
          payTo: PROVIDER_WALLET,
          maxTimeoutSeconds: 300
        }],
        facilitator: "https://facilitator.x402.org",
        version: "1.0"
      };
      
      res.setHeader("X-Payment", Buffer.from(JSON.stringify(paymentSpec)).toString("base64"));
      res.setHeader("Access-Control-Expose-Headers", "X-Payment, X-Payment-Response");
      return res.status(402).json({
        error: "Payment Required",
        message: "x402 payment required to access this resource",
        price: PRICE,
        network: NETWORK,
        payTo: PROVIDER_WALLET
      });
    }
    
    // Payment received - simulate verification and fulfillment
    const body = req.body || {};
    const intentId = body.intentId;
    const input = body.input;
    
    // Simulate a transaction hash
    const mockTxHash = "0x" + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join("");
    
    // Simulate work result
    const preview = typeof input === "string" ? input.substring(0, 50) : JSON.stringify(input || {}).substring(0, 50);
    const result = "Fulfilled intent " + intentId + ": " + preview + "...";
    
    // Return x402 payment response header
    const paymentResponse = {
      success: true,
      txHash: mockTxHash,
      network: NETWORK,
      amount: PRICE
    };
    res.setHeader("X-Payment-Response", Buffer.from(JSON.stringify(paymentResponse)).toString("base64"));
    res.setHeader("Access-Control-Expose-Headers", "X-Payment, X-Payment-Response");
    
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
    payTo: PROVIDER_WALLET 
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Mock x402 provider on http://localhost:" + PORT);
  console.log("Payments to: " + PROVIDER_WALLET);
});
