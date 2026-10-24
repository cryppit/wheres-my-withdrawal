import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, keccakText } from "../src/keccak.js";
import { selector, topic, encodeCall, word, decodeWords, decodeBytes, toAddress, fromHex } from "../src/abi.js";

test("keccak256 matches the standard vectors", () => {
  assert.equal(keccakText(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccakText("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // exactly one 136-byte block (padding goes in a second block), and longer than one
  assert.equal(keccak256(new Uint8Array(136)), "0x3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9");
  assert.equal(keccak256(new Uint8Array(200)), "0xe1bb54e1bc3af48d01e5dbfc81015c98152a574f6428c6948aa4837c9c0baad9");
});

test("selectors and topics match the deployed contracts", () => {
  assert.equal(selector("finalizedWithdrawals(bytes32)"), "0xa14238e7");
  assert.equal(selector("provenWithdrawals(bytes32,address)"), "0xbb2c727e");
  assert.equal(selector("numProofSubmitters(bytes32)"), "0x513747ab");
  assert.equal(selector("checkWithdrawal(bytes32,address)"), "0x71c1566e");
  assert.equal(selector("proveWithdrawalTransaction((uint256,address,address,uint256,uint256,bytes),uint256,(bytes32,bytes32,bytes32,bytes32),bytes[])"), "0x4870496f");
  assert.equal(selector("finalizeWithdrawalTransactionExternalProof((uint256,address,address,uint256,uint256,bytes),address)"), "0x43ca1c50");
  assert.equal(topic("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)"), "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054");
});

test("encodes static arguments as 32-byte words", () => {
  const h = "0x" + "ab".repeat(32);
  assert.equal(encodeCall("provenWithdrawals(bytes32,address)", [h, "0x00000000000000000000000000000000000000Ff"]),
    "0xbb2c727e" + "ab".repeat(32) + "0".repeat(62) + "ff");
  assert.equal(word(5n), "0".repeat(63) + "5");
});

test("decodes words, addresses and dynamic bytes", () => {
  const data = "0x" + word(64n) + word(1n) + word(3n) + "abcdef" + "0".repeat(58);
  const w = decodeWords(data);
  assert.equal(w.length, 4);
  assert.equal(decodeBytes(data, 0), "0xabcdef");
  assert.equal(toAddress("0x" + "0".repeat(24) + "25ace71c97b33cc4729cf772ae268934f7ab5fa1"), "0x25ace71c97b33cc4729cf772ae268934f7ab5fa1");
  assert.deepEqual([...fromHex("0x0aff")], [10, 255]);
});
