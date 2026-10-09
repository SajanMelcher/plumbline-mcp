/**
 * Sui TESTNET end-to-end for the optional pay-per-call flow (real chain, real tx, no mocks).
 *
 * - Creates a THROWAWAY testnet payer keypair (never a real wallet) and stores it OUTSIDE the repo at
 *   /tmp/plumbline-sui-testnet-payer.key (0600), so it can be funded and the test re-run.
 * - Generates a throwaway payTo address; its key is discarded immediately.
 * - Tries the official testnet faucet for gas. If the faucet refuses, the script stops and says so.
 * - Needs >= 0.01 testnet USDC on the payer, or set E2E_ASSET=SUI to pay in testnet SUI (test-only override).
 * - Starts Plumbline over HTTP with payments on (free tier = 1) and checks: free call -> 402 -> real Sui transfer -> verified -> served -> credits by token -> replay rejected.
 *
 * Usage: npm run build && node --import tsx scripts/sui-testnet-e2e.ts
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const KEY_FILE = "/tmp/plumbline-sui-testnet-payer.key";
const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const useSui = process.env.E2E_ASSET === "SUI";
const asset = useSui ? "0x2::sui::SUI" : USDC;

async function main() {
  let kp: Ed25519Keypair;
  if (existsSync(KEY_FILE)) kp = Ed25519Keypair.fromSecretKey(readFileSync(KEY_FILE, "utf8").trim());
  else {
    kp = new Ed25519Keypair();
    writeFileSync(KEY_FILE, kp.getSecretKey() + "\n", { mode: 0o600 });
  }
  const payer = kp.getPublicKey().toSuiAddress();
  const payTo = new Ed25519Keypair().getPublicKey().toSuiAddress(); // throwaway receiver
  const rpc = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" } as any);
  const balanceOf = async (coinType?: string) => BigInt((await rpc.getBalance({ owner: payer, ...(coinType ? { coinType } : {}) })).balance.balance);
  console.log(`throwaway testnet payer: ${payer}`);

  let sui = await balanceOf();
  if (sui < 50_000_000n) {
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: payer });
      await new Promise((r) => setTimeout(r, 3000));
      sui = await balanceOf();
    } catch (e) {
      console.log(`FAUCET BLOCKED: ${(e as Error).message}`);
    }
  }
  const bal = await balanceOf(asset);
  console.log(`balances: SUI=${sui} MIST, payment asset (${useSui ? "SUI" : "USDC"})=${bal} atomic`);
  const need = 10_000n; // 0.01 USDC (or 10000 MIST in SUI mode)
  if (sui < 10_000_000n || bal < need) {
    console.log(`SKIPPED: the throwaway payer is unfunded (it needs testnet SUI for gas${useSui ? "" : " and >= 0.01 testnet USDC"}).`);
    console.log(`Fund ${payer} from faucet.sui.io (SUI) and faucet.circle.com (Sui testnet USDC), then re-run.`);
    process.exit(2);
  }

  const port = 19500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ["dist/index.js", "--http", "--port", String(port)], {
    env: {
      ...process.env,
      PLUMBLINE_PAYMENTS: "1",
      PAYTO_ADDRESS: payTo,
      PLUMBLINE_SUI_NETWORK: "testnet",
      PLUMBLINE_FREE_CALLS_PER_DAY: "1",
      ...(useSui ? { PLUMBLINE_TEST_ASSET: "0x2::sui::SUI", PLUMBLINE_TEST_ASSET_DECIMALS: "6" } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((res, rej) => {
    let log = "";
    child.stderr!.on("data", (d) => ((log += d), log.includes("streamable HTTP") && res()));
    setTimeout(() => rej(new Error(log)), 15000);
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const call = (a: Record<string, unknown> = {}) => client.callTool({ name: "get_mid_price", arguments: { pool: "SUI_USDC", ...a } }) as Promise<any>;

  const r1 = await call();
  console.log(`call 1 (free): isError=${Boolean(r1.isError)}`);
  const r2 = await call();
  const req = r2.structuredContent?.accepts?.[0];
  const token = req?.extra?.paymentToken;
  console.log(`call 2: 402 -> exact amount=${req?.amount} asset=${req?.asset} payTo=${req?.payTo} (token received)`);

  const tx = new Transaction();
  tx.transferObjects([coinWithBalance({ type: asset, balance: BigInt(req.amount) })], req.payTo);
  const exec: any = await rpc.signAndExecuteTransaction({ transaction: tx, signer: kp } as any);
  const res = { digest: exec.digest ?? exec.Transaction?.digest ?? exec.transaction?.digest };
  await rpc.waitForTransaction({ digest: res.digest } as any);
  await new Promise((r) => setTimeout(r, 3000)); // let GraphQL index it
  console.log(`paid on testnet: digest=${res.digest}`);

  const r3 = await call({ payment_token: token, payment_tx: res.digest });
  console.log(`call 3 (with digest): isError=${Boolean(r3.isError)} receipt=${JSON.stringify(r3._meta?.["x402/payment-response"] ?? r3.structuredContent?.error)}`);
  const r4 = await call({ payment_token: token });
  console.log(`call 4 (token only): ${r4.isError ? "rejected (" + r4.structuredContent?.error + ")" : "served from credits"}`);
  const r5 = await call({ payment_token: token, payment_tx: res.digest });
  console.log(`call 5 (replay): ${r5.isError ? "rejected (" + r5.structuredContent?.error + ")" : "UNEXPECTEDLY ACCEPTED"}`);
  await client.close();
  child.kill();
  const ok = !r1.isError && r2.isError && !r3.isError && !r4.isError && r5.isError;
  console.log(ok ? "E2E OK" : "E2E FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
