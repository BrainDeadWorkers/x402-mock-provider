/**
 * Real x402 provider for Base Sepolia
 * 
 * Uses EIP-3009 transferWithAuthorization for gasless USDC transfers.
 * The payer signs an authorization, and this server submits it on-chain.
 */
const express = require("express");
const { ethers } = require("ethers");

const app = express();
app.use(express.json());

// Configuration
const PROVIDER_WALLET = process.env.PROVIDER_WALLET || "0xe08Ad6b0975222f410Eb2fa0e50c7Ee8FBe78F2D";
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY; // For submitting the transfer
const PRICE_USDC = "10000"; // 0.01 USDC (6 decimals)
const NETWORK = "eip155:84532"; // Base Sepolia
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";

// Base Sepolia USDC contract
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function name() external view returns (string)",
  "function version() external view returns (string)"
];

// CORS headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment, X-Payment-Signature, Payment-Signature, PAYMENT-SIGNATURE");
  res.setHeader("Access-Control-Expose-Headers", "X-Payment, X-Payment-Response, Payment-Required, PAYMENT-REQUIRED, Payment-Response, PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Base64 helpers
const b64encode = (data) => Buffer.from(JSON.stringify(data)).toString("base64");
const b64decode = (data) => JSON.parse(Buffer.from(data, "base64").toString("utf-8"));

// Build payment requirements for 402 response (x402 v1 format - more compatible)
function buildPaymentRequired(resource) {
  return {
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      maxAmountRequired: PRICE_USDC,
      asset: USDC_ADDRESS,
      resource: resource || "/fulfill",
      description: "Intent fulfillment",
      mimeType: "application/json",
      outputSchema: {},
      payTo: PROVIDER_WALLET,
      maxTimeoutSeconds: 300,
      extra: {
        name: "USDC",      // EIP-712 domain name
        version: "2",      // EIP-712 domain version  
        decimals: 6
      }
    }]
  };
}

// Execute the transferWithAuthorization on-chain
async function executeTransfer(authorization) {
  if (!PROVIDER_PRIVATE_KEY) {
    throw new Error("PROVIDER_PRIVATE_KEY not configured - cannot execute transfers");
  }
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PROVIDER_PRIVATE_KEY, provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, wallet);
  
  console.log("Executing transferWithAuthorization...");
  console.log("  From:", authorization.from);
  console.log("  To:", authorization.to);
  console.log("  Value:", authorization.value);
  
  // Parse signature
  const sig = ethers.Signature.from(authorization.signature);
  
  // Execute the transfer
  const tx = await usdc.transferWithAuthorization(
    authorization.from,
    authorization.to,
    authorization.value,
    authorization.validAfter,
    authorization.validBefore,
    authorization.nonce,
    sig.v,
    sig.r,
    sig.s
  );
  
  console.log("  TX Hash:", tx.hash);
  
  // Wait for confirmation
  const receipt = await tx.wait();
  console.log("  Confirmed in block:", receipt.blockNumber);
  
  return {
    transaction: tx.hash,
    payer: authorization.from,
    payee: authorization.to,
    amount: authorization.value,
    blockNumber: receipt.blockNumber
  };
}

// Extract payment from headers
function extractPayment(req) {
  const header = req.headers["payment-signature"] || 
                 req.headers["x-payment-signature"] ||
                 req.headers["x-payment"];
  
  if (!header) return null;
  
  try {
    return b64decode(header);
  } catch (e) {
    console.error("Failed to decode payment:", e.message);
    return null;
  }
}

// Fulfill endpoint - x402 protected
app.post("/fulfill", async (req, res) => {
  try {
    const body = req.body || {};
    const intentId = body.intentId || "unknown";
    
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Fulfill request: intentId=${intentId}`);
    
    const payment = extractPayment(req);
    
    if (!payment) {
      // No payment - return 402
      console.log("No payment - returning 402 Payment Required");
      const paymentRequired = buildPaymentRequired(req.originalUrl);
      res.setHeader("PAYMENT-REQUIRED", b64encode(paymentRequired));
      res.status(402).json({
        error: "Payment required",
        x402Version: 1,
        message: `Pay ${parseInt(PRICE_USDC) / 1e6} USDC to ${PROVIDER_WALLET}`
      });
      return;
    }
    
    console.log("Payment received, attempting settlement...");
    console.log("Payment payload:", JSON.stringify(payment, null, 2));
    
    // For demo: if no private key, return mock success
    if (!PROVIDER_PRIVATE_KEY) {
      console.log("⚠️ No PROVIDER_PRIVATE_KEY - returning mock success");
      const mockTx = "0x" + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
      
      res.setHeader("PAYMENT-RESPONSE", b64encode({ success: true, transaction: mockTx }));
      res.json({
        success: true,
        intentId,
        result: `Fulfilled (mock): ${intentId}`,
        payment: { status: "mock", txHash: mockTx, network: NETWORK }
      });
      return;
    }
    
    // Extract authorization from payment payload
    const auth = payment.payload?.authorization || payment.authorization || payment;
    
    if (!auth.from || !auth.signature) {
      throw new Error("Invalid payment: missing authorization data");
    }
    
    // Execute the real transfer
    const settlement = await executeTransfer(auth);
    
    console.log(`${"=".repeat(60)}`);
    console.log(`✅ REAL PAYMENT SETTLED!`);
    console.log(`   TX: https://sepolia.basescan.org/tx/${settlement.transaction}`);
    console.log(`${"=".repeat(60)}\n`);
    
    res.setHeader("PAYMENT-RESPONSE", b64encode({ 
      success: true, 
      transaction: settlement.transaction,
      network: NETWORK 
    }));
    
    res.json({
      success: true,
      intentId,
      result: `Fulfilled intent ${intentId}`,
      timestamp: new Date().toISOString(),
      payment: {
        status: "settled",
        txHash: settlement.transaction,
        network: NETWORK,
        amount: `${parseInt(PRICE_USDC) / 1e6} USDC`,
        payer: settlement.payer,
        payee: settlement.payee,
        basescanUrl: `https://sepolia.basescan.org/tx/${settlement.transaction}`
      }
    });
    
  } catch (err) {
    console.error("Fulfill error:", err);
    res.status(500).json({ 
      error: "Payment settlement failed", 
      reason: err.message 
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    x402: true,
    x402Version: 1,
    realPayments: !!PROVIDER_PRIVATE_KEY,
    network: NETWORK,
    payTo: PROVIDER_WALLET,
    price: `${parseInt(PRICE_USDC) / 1e6} USDC`
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "x402 Provider",
    network: NETWORK,
    payTo: PROVIDER_WALLET,
    price: `${parseInt(PRICE_USDC) / 1e6} USDC`,
    realPayments: !!PROVIDER_PRIVATE_KEY
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`x402 Provider running on port ${PORT}`);
  console.log(`  Network: ${NETWORK}`);
  console.log(`  PayTo: ${PROVIDER_WALLET}`);
  console.log(`  Real payments: ${!!PROVIDER_PRIVATE_KEY}`);
});
