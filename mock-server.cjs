/**
 * Real x402 provider for Base Sepolia
 * 
 * Implements the x402 protocol with real USDC payments via x402.org facilitator.
 * Flow:
 * 1. Request without payment → 402 with PAYMENT-REQUIRED header
 * 2. Client signs EIP-712 authorization, retries with PAYMENT-SIGNATURE header
 * 3. Server calls x402.org facilitator to verify + settle payment on-chain
 * 4. Returns response with PAYMENT-RESPONSE header containing tx hash
 */
const express = require("express");

const app = express();
app.use(express.json());

const PROVIDER_WALLET = process.env.PROVIDER_WALLET || "0xe08Ad6b0975222f410Eb2fa0e50c7Ee8FBe78F2D";
const PRICE_USDC = "10000"; // 0.01 USDC (6 decimals)
const NETWORK = "eip155:84532"; // Base Sepolia
const X402_VERSION = 2;
const FACILITATOR_URL = "https://x402.org/facilitator";

// CORS headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment, X-Payment-Signature, Payment-Signature, PAYMENT-SIGNATURE");
  res.setHeader("Access-Control-Expose-Headers", "X-Payment, X-Payment-Response, Payment-Required, PAYMENT-REQUIRED, Payment-Response, PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Base64 encoding/decoding helpers
function safeBase64Encode(data) {
  return Buffer.from(data, "utf8").toString("base64");
}

function safeBase64Decode(data) {
  return Buffer.from(data, "base64").toString("utf-8");
}

// Build x402 v2 payment requirements
// Note: EIP-3009 requires EIP-712 domain params (name, version) in extra
// For USDC on Base Sepolia, name="USD Coin" version="2" (standard USDC contract)
function buildPaymentRequirements() {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_USDC,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
    payTo: PROVIDER_WALLET,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",   // EIP-712 domain name for USDC
      version: "2",       // EIP-712 domain version for USDC
      decimals: 6
    }
  };
}

// Build x402 v2 PAYMENT-REQUIRED response
function buildPaymentRequired(resource) {
  return {
    x402Version: X402_VERSION,
    error: "Payment required",
    resource: {
      url: resource || "/fulfill",
      description: "Intent fulfillment service",
      mimeType: "application/json"
    },
    accepts: [buildPaymentRequirements()]
  };
}

// Call x402.org facilitator to verify payment
async function verifyPayment(paymentPayload, paymentRequirements) {
  const response = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload: paymentPayload,
      paymentRequirements: paymentRequirements
    })
  });
  
  const data = await response.json();
  console.log("Facilitator verify response:", JSON.stringify(data));
  
  if (!response.ok || !data.isValid) {
    throw new Error(data.invalidReason || data.invalidMessage || "Verification failed");
  }
  
  return data;
}

// Call x402.org facilitator to settle payment (executes on-chain transfer)
async function settlePayment(paymentPayload, paymentRequirements) {
  const response = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload: paymentPayload,
      paymentRequirements: paymentRequirements
    })
  });
  
  const data = await response.json();
  console.log("Facilitator settle response:", JSON.stringify(data));
  
  if (!response.ok || !data.success) {
    throw new Error(data.errorReason || data.errorMessage || "Settlement failed");
  }
  
  return data;
}

// Extract payment from request headers (handles v1 and v2 header names)
function extractPayment(req) {
  const header = req.headers["payment-signature"] || 
                 req.headers["PAYMENT-SIGNATURE"] ||
                 req.headers["x-payment"] ||
                 req.headers["X-Payment"];
  
  if (!header) return null;
  
  try {
    return JSON.parse(safeBase64Decode(header));
  } catch (e) {
    console.error("Failed to decode payment header:", e.message);
    return null;
  }
}

// Fulfill endpoint - x402-protected
app.post("/fulfill", async (req, res) => {
  try {
    const body = req.body || {};
    const intentId = body.intentId || "unknown";
    const input = body.input;
    
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Fulfill request: intentId=${intentId}`);
    
    // Check for payment header
    const paymentPayload = extractPayment(req);
    const requirements = buildPaymentRequirements();
    
    if (!paymentPayload) {
      // No payment - return 402 Payment Required
      console.log("No payment header - returning 402");
      const paymentRequired = buildPaymentRequired(req.originalUrl || "/fulfill");
      const encodedHeader = safeBase64Encode(JSON.stringify(paymentRequired));
      
      res.setHeader("PAYMENT-REQUIRED", encodedHeader);
      res.status(402).json({
        error: "Payment required",
        x402Version: X402_VERSION,
        message: `Pay ${parseInt(PRICE_USDC) / 1000000} USDC to ${PROVIDER_WALLET}`
      });
      return;
    }
    
    console.log("Payment payload received, x402Version:", paymentPayload.x402Version);
    console.log("Accepted requirements:", JSON.stringify(paymentPayload.accepted || paymentPayload.payload?.authorization));
    
    // Verify payment with facilitator
    console.log("Verifying payment with x402.org facilitator...");
    try {
      await verifyPayment(paymentPayload, requirements);
      console.log("Payment verified ✓");
    } catch (e) {
      console.error("Payment verification failed:", e.message);
      const paymentRequired = buildPaymentRequired(req.originalUrl || "/fulfill");
      const encodedHeader = safeBase64Encode(JSON.stringify({
        ...paymentRequired,
        error: e.message
      }));
      
      res.setHeader("PAYMENT-REQUIRED", encodedHeader);
      res.status(402).json({
        error: "Payment verification failed",
        reason: e.message
      });
      return;
    }
    
    // Settle payment with facilitator (this executes the on-chain transfer!)
    console.log("Settling payment with x402.org facilitator (executing on-chain transfer)...");
    let settleResponse;
    try {
      settleResponse = await settlePayment(paymentPayload, requirements);
      console.log("Payment settled ✓");
      console.log("Transaction hash:", settleResponse.transaction);
    } catch (e) {
      console.error("Payment settlement failed:", e.message);
      res.status(500).json({
        error: "Payment settlement failed",
        reason: e.message
      });
      return;
    }
    
    // Generate result
    const preview = typeof input === "string" ? input.substring(0, 50) : JSON.stringify(input || {}).substring(0, 50);
    const result = `Fulfilled intent ${intentId}: ${preview}...`;
    
    // Set PAYMENT-RESPONSE header with settlement info
    const paymentResponse = {
      success: true,
      transaction: settleResponse.transaction,
      network: NETWORK,
      payer: settleResponse.payer
    };
    res.setHeader("PAYMENT-RESPONSE", safeBase64Encode(JSON.stringify(paymentResponse)));
    
    console.log(`${"=".repeat(60)}`);
    console.log(`SUCCESS! Real USDC payment received!`);
    console.log(`TX: https://sepolia.basescan.org/tx/${settleResponse.transaction}`);
    console.log(`${"=".repeat(60)}\n`);
    
    res.json({
      success: true,
      intentId,
      result,
      timestamp: new Date().toISOString(),
      payment: {
        status: "settled",
        txHash: settleResponse.transaction,
        network: NETWORK,
        amount: `${parseInt(PRICE_USDC) / 1000000} USDC`,
        payTo: PROVIDER_WALLET,
        payer: settleResponse.payer,
        basescanUrl: `https://sepolia.basescan.org/tx/${settleResponse.transaction}`
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
    x402Version: X402_VERSION,
    realPayments: true,
    network: NETWORK,
    payTo: PROVIDER_WALLET,
    price: `${parseInt(PRICE_USDC) / 1000000} USDC`,
    facilitator: FACILITATOR_URL
  });
});

// Info endpoint
app.get("/", (req, res) => {
  res.json({
    service: "x402 Provider (Real Payments)",
    version: "1.0.0",
    x402Version: X402_VERSION,
    network: NETWORK,
    payTo: PROVIDER_WALLET,
    price: `${parseInt(PRICE_USDC) / 1000000} USDC`,
    endpoints: {
      fulfill: "POST /fulfill (x402-protected)",
      health: "GET /health"
    }
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     x402 Provider - REAL USDC Payments on Base Sepolia       ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Server:     http://localhost:${PORT}                           ║`);
  console.log(`║  Network:    ${NETWORK}                              ║`);
  console.log(`║  Price:      ${(parseInt(PRICE_USDC) / 1000000).toFixed(2)} USDC                                        ║`);
  console.log(`║  PayTo:      ${PROVIDER_WALLET}  ║`);
  console.log(`║  Facilitator: ${FACILITATOR_URL}               ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
});
