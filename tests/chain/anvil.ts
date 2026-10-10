// Local chain for integration tests: spawns anvil (Foundry) and deploys compiled contracts from contracts/out.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  custom,
  type Hex,
  type PublicClient,
  type Abi,
  defineChain,
  type EIP1193RequestFn,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../../src/lib/db-rpc";
import { rpc, setRole, type Sql } from "../../supabase/tests/db/harness";

export const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  player: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
  other: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex,
};

const ANVIL =
  process.env["ANVIL_BIN"] ?? (existsSync("/opt/foundry/anvil") ? "/opt/foundry/anvil" : "anvil");
const OUT = join(import.meta.dirname, "..", "..", "contracts", "out");

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export async function startAnvil(chainId = 31337) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: ChildProcess = spawn(
    ANVIL,
    ["--port", String(port), "--chain-id", String(chainId), "--silent", "--slots-in-an-epoch", "1"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: chainId,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const pub = createPublicClient({ chain, transport: http(url), cacheTime: 0 }) as PublicClient;
  const wallet = (key: Hex) =>
    createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(url) });
  return {
    url,
    chain,
    pub,
    wallet,
    async mine(n = 1) {
      await pub.request({
        method: "anvil_mine" as never,
        params: [`0x${n.toString(16)}`] as never,
      });
    },
    async deploy(art: { abi: Abi; bytecode: Hex }, args: unknown[] = [], key: Hex = KEYS.owner) {
      const w = wallet(key);
      const hash = await w.deployContract({
        abi: art.abi,
        bytecode: art.bytecode,
        args,
        account: w.account!,
        chain,
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      return r.contractAddress! as Hex;
    },
    /** A public client whose transport can be intercepted per JSON-RPC method (to simulate network failures). */
    interceptedClient(
      intercept: (
        method: string,
        params: unknown,
        forward: () => Promise<unknown>,
      ) => Promise<unknown>,
    ) {
      const base = http(url)({ chain });
      const request: EIP1193RequestFn = (async (args: { method: string; params?: unknown }) =>
        intercept(args.method, args.params, () => base.request(args as never))) as EIP1193RequestFn;
      return createPublicClient({
        chain,
        transport: custom({ request }),
        cacheTime: 0,
      }) as PublicClient;
    },
    stop() {
      proc.kill("SIGKILL");
    },
  };
}

/** Db adapter over a real PostgreSQL connection, calling RPCs as the service role (like the server does). */
export function pgDb(sql: Sql): Db {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      const rows = await rpc<Record<string, unknown>>(sql, fn, args);
      // Scalar-returning functions come back as { fn: value } rows; unwrap like PostgREST does.
      if (rows.length === 1 && Object.keys(rows[0]!).length === 1 && fn in rows[0]!)
        return [rows[0]![fn]] as T[];
      return rows.map(normaliseRow) as T[];
    },
    async select<T>(table: string, filter: Record<string, unknown>, columns = "*") {
      const keys = Object.keys(filter);
      const where = keys.map((k, i) => `${k} = $${i + 1}`).join(" and ");
      return (
        await sql.begin(async (tx) => {
          await setRole(tx as unknown as Sql, "service_role");
          return tx.unsafe(
            `select ${columns} from public.${table}${where ? ` where ${where}` : ""}`,
            keys.map((k) => filter[k]) as never[],
          );
        })
      ).map(normaliseRow) as unknown as T[];
    },
  };
}

// PostgREST returns timestamps as ISO strings and bigints as numbers; mirror that so modules see the same shapes.
function normaliseRow(r: unknown) {
  if (!r || typeof r !== "object") return r;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>))
    o[k] = v instanceof Date ? v.toISOString() : v;
  return o;
}
