import {
  Cl,
  createStacksPrivateKey,
  cvToValue,
  signMessageHashRsv,
  ClarityValue,
} from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import { signSync } from "@noble/secp256k1"; // Add this for fallback signing

const accounts = simnet.getAccounts();
const sender = accounts.get("wallet_1")!;
const recipient = accounts.get("wallet_2")!;
const randomUser = accounts.get("wallet_3")!;

// Helper function to create private key with fallback for @stacks/transactions@7.2.0
const createPrivateKeyFallback = (key: string) => {
  try {
    // Ensure key is 32 bytes (64 hex chars)
    if (key.length !== 64) {
      throw new Error(`Invalid private key length: ${key.length}, expected 64 hex chars`);
    }
    const privateKey = createStacksPrivateKey(key);
    console.log("Private key created:", privateKey); // Log private key object
    return privateKey;
  } catch (error) {
    console.error("createStacksPrivateKey failed:", error.message);
    // Fallback: create a raw Buffer for signing
    const keyBuffer = Buffer.from(key, "hex");
    console.log("Fallback private key buffer:", keyBuffer.toString("hex"));
    return { data: keyBuffer }; // Compatible with signMessageHashRsv
  }
};

// Helper function to safely extract the hash buffer from a Clarity buffer or Response
function extractHashBuffer(response: any): Buffer {
  if (response.result && response.result.type === "buffer") {
    // Direct buffer returned by hash-stream (Clarity 3.7.0 behavior)
    const hash = Buffer.from(response.result.value, "hex");
    console.log("Extracted hash buffer:", hash.toString("hex")); // Log hash
    return hash;
  } else if (
    response.result &&
    response.result.type === "response" &&
    "ok" in response.result.value
  ) {
    // Response with (ok <buffer>) - for compatibility
    const hash = Buffer.from(response.result.value.ok.data);
    console.log("Extracted hash buffer (response):", hash.toString("hex")); // Log hash
    return hash;
  } else {
    throw new Error(
      `hash-stream failed or returned an invalid response: ${JSON.stringify(
        response.result
      )}`
    );
  }
}

// Fallback signing using @noble/secp256k1
const signMessageFallback = (messageHash: string, privateKey: Buffer) => {
  try {
    const [sig, recovery] = signSync(Buffer.from(messageHash, "hex"), privateKey, {
      recovered: true,
      der: false,
    });
    const signature = Buffer.concat([Buffer.from(sig), Buffer.from([recovery])]).toString("hex");
    console.log("Fallback signature:", signature); // Log signature
    return { data: signature };
  } catch (error) {
    console.error("Fallback signing failed:", error.message);
    throw error;
  }
};

describe("test token streaming contract", () => {
  beforeEach(() => {
    // Ensure stream 0 exists before the signature tests run
    const result = simnet.callPublicFn(
      "streaming-protocol",
      "stream-to",
      [
        Cl.principal(recipient),
        Cl.uint(5),
        Cl.tuple({ "start-block": Cl.uint(0), "stop-block": Cl.uint(5) }),
        Cl.uint(1),
      ],
      sender
    );

    expect(result.events[0].event).toBe("stx_transfer_event");
    expect(result.events[0].data.amount).toBe("5");
    expect(result.events[0].data.sender).toBe(sender);
  });

  it("ensures contract is initialized properly and stream is created", () => {
    const latestStreamId = simnet.getDataVar(
      "streaming-protocol",
      "latest-stream-id"
    );
    expect(latestStreamId).toBeUint(1);

    const createdStream = simnet.getMapEntry(
      "streaming-protocol",
      "streams",
      Cl.uint(0)
    );
    expect(createdStream).toBeSome(
      Cl.tuple({
        sender: Cl.principal(sender),
        recipient: Cl.principal(recipient),
        balance: Cl.uint(5),
        "withdrawn-balance": Cl.uint(0),
        "payment-per-block": Cl.uint(1),
        timeframe: Cl.tuple({
          "start-block": Cl.uint(0),
          "stop-block": Cl.uint(5),
        }),
      })
    );
  });

  it("ensures stream can be refueled", () => {
    const result = simnet.callPublicFn(
      "streaming-protocol",
      "refuel",
      [Cl.uint(0), Cl.uint(5)],
      sender
    );

    expect(result.events[0].event).toBe("stx_transfer_event");
    expect(result.events[0].data.amount).toBe("5");
    expect(result.events[0].data.sender).toBe(sender);

    const createdStream = simnet.getMapEntry(
      "streaming-protocol",
      "streams",
      Cl.uint(0)
    );
    expect(createdStream).toBeSome(
      Cl.tuple({
        sender: Cl.principal(sender),
        recipient: Cl.principal(recipient),
        balance: Cl.uint(10),
        "withdrawn-balance": Cl.uint(0),
        "payment-per-block": Cl.uint(1),
        timeframe: Cl.tuple({
          "start-block": Cl.uint(0),
          "stop-block": Cl.uint(5),
        }),
      })
    );
  });

  it("ensures stream cannot be refueled by random address", () => {
    const result = simnet.callPublicFn(
      "streaming-protocol",
      "refuel",
      [Cl.uint(0), Cl.uint(5)],
      randomUser
    );

    expect(result.result).toBeErr(Cl.uint(0));
  });

  it("ensures recipient can withdraw tokens over time", () => {
    const withdraw = simnet.callPublicFn(
      "streaming-protocol",
      "withdraw",
      [Cl.uint(0)],
      recipient
    );

    expect(withdraw.events[0].event).toBe("stx_transfer_event");
    expect(withdraw.events[0].data.amount).toBe("4");
    expect(withdraw.events[0].data.recipient).toBe(recipient);
  });

  it("ensures non-recipient cannot withdraw tokens from stream", () => {
    const withdraw = simnet.callPublicFn(
      "streaming-protocol",
      "withdraw",
      [Cl.uint(0)],
      randomUser
    );

    expect(withdraw.result).toBeErr(Cl.uint(0));
  });

  it("ensures sender can withdraw excess tokens", () => {
    simnet.callPublicFn("streaming-protocol", "refuel", [Cl.uint(0), Cl.uint(5)], sender);
    simnet.mineEmptyBlock();
    simnet.mineEmptyBlock();
    simnet.callPublicFn("streaming-protocol", "withdraw", [Cl.uint(0)], recipient);

    const refund = simnet.callPublicFn(
      "streaming-protocol",
      "refund",
      [Cl.uint(0)],
      sender
    );

    expect(refund.events[0].event).toBe("stx_transfer_event");
    expect(refund.events[0].data.amount).toBe("5");
    expect(refund.events[0].data.recipient).toBe(sender);
  });

  it("signature verification can be done on stream hashes", () => {
    const timeframeTuple = Cl.tuple({ "start-block": Cl.uint(1), "stop-block": Cl.uint(2) });

    const hashedStream0 = simnet.callReadOnlyFn(
      "streaming-protocol",
      "hash-stream",
      [
        Cl.uint(0), // stream-id
        Cl.uint(0), // payment-per-block
        timeframeTuple,
      ],
      sender
    );

    // Extract and log the hash buffer
    const hashBuffer = extractHashBuffer(hashedStream0);

    // Sign the hash
    const privateKeyHex = "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c178";
    const privateKey = createPrivateKeyFallback(privateKeyHex);
    let signature;
    try {
      signature = signMessageHashRsv({
        messageHash: hashBuffer.toString("hex"),
        privateKey,
      });
      console.log("Signature (signature verification):", signature.data);
    } catch (error) {
      console.error("signMessageHashRsv failed:", error.message);
      // Fallback to noble/secp256k1
      signature = signMessageFallback(hashBuffer.toString("hex"), Buffer.from(privateKeyHex, "hex"));
    }

    // Verify the signature
    const verifySignature = simnet.callReadOnlyFn(
      "streaming-protocol",
      "validate-signature",
      [
        Cl.buffer(hashBuffer), // Raw hash buffer
        Cl.buffer(Buffer.from(signature.data, "hex")), // Signature as Clarity buffer
        Cl.principal(sender),
      ],
      sender
    );

    expect(cvToValue(verifySignature.result)).toBe(true);
  });

  it("ensures timeframe and payment per block can be modified with consent of both parties", () => {
    const newPaymentPerBlock = Cl.uint(1);
    const newTimeframe = Cl.tuple({ "start-block": Cl.uint(0), "stop-block": Cl.uint(4) });

    const hashedStream0 = simnet.callReadOnlyFn(
      "streaming-protocol",
      "hash-stream",
      [
        Cl.uint(0),
        newPaymentPerBlock,
        newTimeframe,
      ],
      sender
    );

    // Extract and log the hash buffer
    const hashBuffer = extractHashBuffer(hashedStream0);

    // Sign the hash
    const privateKeyHex = "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c178";
    const privateKey = createPrivateKeyFallback(privateKeyHex);
    let senderSignature;
    try {
      senderSignature = signMessageHashRsv({
        messageHash: hashBuffer.toString("hex"),
        privateKey,
      });
      console.log("Signature (update details):", senderSignature.data);
    } catch (error) {
      console.error("signMessageHashRsv failed:", error.message);
      // Fallback to noble/secp256k1
      senderSignature = signMessageFallback(hashBuffer.toString("hex"), Buffer.from(privateKeyHex, "hex"));
    }

    // Update stream details
    const updateResult = simnet.callPublicFn(
      "streaming-protocol",
      "update-details",
      [
        Cl.uint(0), // stream-id
        newPaymentPerBlock, // new payment-per-block
        newTimeframe, // new timeframe
        Cl.principal(sender), // signer
        Cl.buffer(Buffer.from(senderSignature.data, "hex")), // Signature as Clarity buffer
      ],
      recipient // contract-caller
    );

    // Expect the update to succeed
    expect(updateResult.result).toBeOk(Cl.bool(true));

    const updatedStream = simnet.getMapEntry(
      "streaming-protocol",
      "streams",
      Cl.uint(0)
    );
    expect(updatedStream).toBeSome(
      Cl.tuple({
        sender: Cl.principal(sender),
        recipient: Cl.principal(recipient),
        balance: Cl.uint(5),
        "withdrawn-balance": Cl.uint(0),
        "payment-per-block": newPaymentPerBlock,
        timeframe: newTimeframe,
      })
    );
  });
});