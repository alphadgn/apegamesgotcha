// Admin → Treasury (super admin). Phase 1: deploy the GotchaFeeSplitter.
//   1. Compile: solc-js v0.8.24+commit.e11b9ed9 in a Web Worker (public/solc), optimizer 200 runs, shanghai.
//      The result must match the reviewed source's bytecode fingerprint before Deploy is allowed.
//   2. Deploy from the wallet in this browser (MetaMask, Rabby…; on a phone, open the site in the wallet app).
//   3. The server checks the deployment on-chain and saves it; the verification settings for ApeScan are shown.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { createWalletClient, custom, defineChain, encodeAbiParameters, isAddress, zeroAddress, type Hex } from "viem";
import SOURCE from "@/contracts/GotchaFeeSplitter.sol?raw";
import {
  BUCKETS,
  COMPILER,
  DEFAULT_OWNER,
  EXPECTED_BYTECODE_SHA256,
  SPLITTER_ABI,
  SPLITTER_CHAINS,
  SPLITTER_FILE,
  SPLITTER_NAME,
  standardJsonInput,
  type SplitterChainId,
} from "@/contracts/splitter";
import { adminListSplitters, adminRecordSplitter, adminSetActiveSplitter, type SplitterRow } from "@/lib/treasury.functions";
import { confirmAction } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const validAddr = (a: string) => isAddress(a.trim(), { strict: false }) && a.trim().toLowerCase() !== zeroAddress;

function viemChain(id: SplitterChainId) {
  const c = SPLITTER_CHAINS[id];
  return defineChain({
    id,
    name: c.name,
    nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    blockExplorers: { default: { name: "ApeScan", url: c.explorer } },
    testnet: c.testnet,
  });
}

async function sha256Hex(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Compiled = { version: string; bytecode: Hex; size: number; matches: boolean; warnings: string[] };
let compiledOnce: Promise<Compiled> | null = null;

/** Compiles the splitter in a Web Worker (once per page load). */
function compileSplitter(): Promise<Compiled> {
  compiledOnce ??= new Promise<Compiled>((resolve, reject) => {
    const w = new Worker("/solc/solc-worker.js");
    const t = window.setTimeout(() => {
      w.terminate();
      reject(new Error("The compiler took too long to load. Check your connection and try again."));
    }, 120_000);
    w.onmessage = async (e: MessageEvent<{ version?: string; output?: any; error?: string }>) => {
      window.clearTimeout(t);
      w.terminate();
      try {
        if (e.data.error) throw new Error(e.data.error);
        const out = e.data.output;
        const errors = ((out.errors ?? []) as { severity: string; formattedMessage: string; message: string }[]);
        const fatal = errors.filter((x) => x.severity === "error");
        if (fatal.length) throw new Error(fatal.map((x) => x.formattedMessage).join("\n"));
        const obj = out.contracts?.[SPLITTER_FILE]?.[SPLITTER_NAME]?.evm?.bytecode?.object as string | undefined;
        if (!obj) throw new Error("The compiler returned no bytecode.");
        const version = String(e.data.version ?? "");
        if (!version.startsWith(COMPILER.version)) throw new Error(`Wrong compiler loaded (${version}); expected ${COMPILER.version}.`);
        resolve({
          version,
          bytecode: `0x${obj}`,
          size: obj.length / 2,
          matches: (await sha256Hex(obj)) === EXPECTED_BYTECODE_SHA256,
          warnings: errors.filter((x) => x.severity !== "error").map((x) => x.message),
        });
      } catch (err) {
        reject(err);
      }
    };
    w.onerror = (ev) => {
      window.clearTimeout(t);
      w.terminate();
      reject(new Error(ev.message || "The compiler couldn't start."));
    };
    w.postMessage({ id: 1, input: standardJsonInput(SOURCE) });
  }).catch((e) => {
    compiledOnce = null; // allow another try
    throw e;
  });
  return compiledOnce;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy");
  }
}

export function TreasuryPanel() {
  const list = useServerFn(adminListSplitters);
  const { data, refetch } = useQuery({ queryKey: ["treasury-splitters"], queryFn: () => list() });
  return (
    <div className="mt-4 space-y-6 text-left">
      <section className="rounded border bg-card p-4">
        <h2 className="text-xl font-bold">Gotcha Treasury</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The GotchaFeeSplitter splits every Gotcha fee into 8 buckets: Team and Operations are paid out directly; the others build up until
          they can buy their prize. Phase 1: deploy it (start on the Curtis testnet).
        </p>
        {data && !data.ready && <p className="mt-2 text-sm text-destructive">The treasury turns on after the database update (0022).</p>}
      </section>
      <DeployCard onSaved={() => void refetch()} />
      <DeploymentsCard rows={data?.rows ?? []} onChanged={() => void refetch()} />
    </div>
  );
}

function DeployCard({ onSaved }: { onSaved: () => void }) {
  const record = useServerFn(adminRecordSplitter);
  const [chainId, setChainId] = useState<SplitterChainId>(33111);
  const [owner, setOwner] = useState(DEFAULT_OWNER);
  const [keeper, setKeeper] = useState("");
  const [recipients, setRecipients] = useState<string[]>(() => BUCKETS.map(() => ""));
  const [account, setAccount] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [step, setStep] = useState<null | string>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const provider = typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;

  const runCompile = () => {
    setCompileError(null);
    compileSplitter().then(setCompiled, (e: Error) => setCompileError(e.message));
  };
  useEffect(runCompile, []);

  const fields = [owner, keeper, ...recipients];
  const bad = useMemo(() => fields.map((a) => !validAddr(a)), [owner, keeper, recipients]); // eslint-disable-line react-hooks/exhaustive-deps
  const formOk = !bad.some(Boolean);
  const argsHex = formOk
    ? encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address[8]" }],
        [owner.trim() as Hex, keeper.trim() as Hex, recipients.map((r) => r.trim() as Hex) as unknown as readonly [Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex]],
      )
    : null;

  const connect = async () => {
    if (!provider) {
      toast.error("No wallet in this browser. Use MetaMask or Rabby on a computer, or open this page inside your wallet app.");
      return;
    }
    try {
      const accts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(accts?.[0]?.toLowerCase() ?? null);
    } catch {
      toast.error("Wallet connection cancelled.");
    }
  };

  const deploy = async () => {
    if (!provider || !account || !compiled?.matches || !formOk) return;
    const chain = viemChain(chainId);
    const meta = SPLITTER_CHAINS[chainId];
    if (
      !(await confirmAction({
        title: `Deploy GotchaFeeSplitter on ${meta.name}?`,
        description: `From ${short(account)}. Owner ${short(owner)}, keeper ${short(keeper)}. Recipients and percentages can't be changed by anyone but the owner, and the percentages are fixed forever.${meta.testnet ? "" : " This is MAINNET: it costs real APE for gas."}`,
        confirmLabel: "Deploy",
        destructive: !meta.testnet,
      }))
    )
      return;
    try {
      setStep("Switching your wallet to the network…");
      const wallet = createWalletClient({ chain, transport: custom(provider) });
      try {
        await wallet.switchChain({ id: chainId });
      } catch {
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chainId });
      }
      setStep("Approve the deployment in your wallet…");
      const hash = await wallet.deployContract({
        abi: SPLITTER_ABI,
        bytecode: compiled.bytecode,
        args: [owner.trim(), keeper.trim(), recipients.map((r) => r.trim())],
        account: account as Hex,
      });
      setLastTx(hash);
      setStep("Deployed — waiting for the network to confirm…");
      for (let i = 0; i < 60; i++) {
        const r = await record({ data: { chainId, txHash: hash } });
        if (r.state === "saved") {
          toast.success(`Splitter deployed at ${short(r.address)}`);
          onSaved();
          setStep(null);
          return;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      toast.info("Still confirming. Your deployment is sent; tap “Check deployment” in a minute.");
    } catch (e) {
      const m = (e as Error).message ?? "Deployment failed";
      toast.error(/reject|denied|cancel/i.test(m) ? "Deployment cancelled." : m.split("\n")[0]!);
    } finally {
      setStep(null);
    }
  };

  const checkLast = async () => {
    if (!lastTx) return;
    try {
      const r = await record({ data: { chainId, txHash: lastTx } });
      if (r.state === "saved") {
        toast.success("Deployment saved");
        onSaved();
      } else toast.info("Not confirmed yet. Try again shortly.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const addrInput = (label: string, value: string, set: (v: string) => void, i: number, hint?: string) => (
    <label className="block text-sm">
      {label}
      {hint && <span className="ml-1 text-xs text-muted-foreground">{hint}</span>}
      <Input className="mt-1 font-mono" placeholder="0x…" value={value} spellCheck={false} onChange={(e) => set(e.target.value)} />
      {value && bad[i] && <span className="text-xs text-destructive">Not a valid address</span>}
    </label>
  );

  return (
    <section className="rounded border bg-card p-4">
      <h3 className="text-lg font-bold">1. Deploy</h3>

      <div className="mt-3 rounded border border-border p-3 text-sm">
        <p className="font-bold">Compiler</p>
        {compiled ? (
          <p className={compiled.matches ? "text-primary" : "text-destructive"}>
            solc {compiled.version.replace(".Emscripten.clang", "")} · optimizer {COMPILER.runs} runs · {COMPILER.evmVersion} · {compiled.size.toLocaleString()} bytes ·{" "}
            {compiled.matches ? "matches the reviewed source ✓" : "does NOT match the reviewed source — deploy blocked"}
          </p>
        ) : compileError ? (
          <p className="text-destructive">
            {compileError}{" "}
            <button type="button" className="underline" onClick={runCompile}>
              Try again
            </button>
          </p>
        ) : (
          <p className="text-muted-foreground">Compiling in your browser (the compiler is about 9 MB the first time)…</p>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          Network
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value) as SplitterChainId)}
          >
            <option value={33111}>{SPLITTER_CHAINS[33111].name}</option>
            <option value={33139}>{SPLITTER_CHAINS[33139].name} — mainnet</option>
          </select>
        </label>
        <div className="text-sm">
          Deploy from
          <div className="mt-1">
            {account ? (
              <span className="font-mono">{short(account)}</span>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void connect()}>
                Connect wallet
              </Button>
            )}
          </div>
        </div>
        {addrInput("Owner", owner, setOwner, 0, "(sets recipients and keeper)")}
        {addrInput("Keeper", keeper, setKeeper, 1, "(bot wallet: sets targets, triggers buys)")}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold">Recipients, in bucket order</p>
        <Button
          size="sm"
          variant="outline"
          disabled={!validAddr(keeper)}
          onClick={() => setRecipients(recipients.map((r, i) => (i >= 4 ? keeper.trim() : r)))}
        >
          Use the keeper as buyer for buckets 4–7
        </Button>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {BUCKETS.map((b, i) =>
          addrInput(
            `${i}. ${b.name}`,
            recipients[i]!,
            (v) => setRecipients(recipients.map((r, j) => (j === i ? v : r))),
            i + 2,
            `${b.bps / 100}% · ${b.mode}`,
          ),
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={!!step || !compiled?.matches || !formOk || !account} onClick={() => void deploy()}>
          {step ?? `Deploy on ${SPLITTER_CHAINS[chainId].testnet ? "Curtis testnet" : "ApeChain MAINNET"}`}
        </Button>
        {lastTx && !step && (
          <Button variant="outline" onClick={() => void checkLast()}>
            Check deployment
          </Button>
        )}
      </div>
      {!account && <p className="mt-2 text-xs text-muted-foreground">Connect the wallet that pays for the deployment first.</p>}
      {argsHex && (
        <p className="mt-3 break-all text-xs text-muted-foreground">
          Constructor arguments (ABI-encoded): <span className="font-mono">{argsHex.slice(2)}</span>
        </p>
      )}
    </section>
  );
}

function DeploymentsCard({ rows, onChanged }: { rows: SplitterRow[]; onChanged: () => void }) {
  const setActive = useServerFn(adminSetActiveSplitter);
  const [open, setOpen] = useState<string | null>(rows[0]?.id ?? null);
  useEffect(() => {
    if (!open && rows[0]) setOpen(rows[0].id);
  }, [rows, open]);
  const makeActive = async (r: SplitterRow) => {
    const meta = SPLITTER_CHAINS[r.chain_id as SplitterChainId];
    if (
      !(await confirmAction({
        title: `Use ${short(r.address)} as the active splitter on ${meta?.name ?? r.chain_id}?`,
        description: "The treasury dashboard and the keeper bot (next phases) will work with this contract.",
        confirmLabel: "Make active",
      }))
    )
      return;
    try {
      await setActive({ data: { id: r.id } });
      toast.success("Active splitter set");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const stdJson = JSON.stringify(
    { ...standardJsonInput(SOURCE), settings: { ...standardJsonInput(SOURCE).settings, outputSelection: { "*": { "*": ["*"] } } } },
    null,
    2,
  );
  return (
    <section className="rounded border bg-card p-4">
      <h3 className="text-lg font-bold">2. Deployments & ApeScan verification</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy(SOURCE, "Source")}>
          Copy source
        </Button>
        <Button size="sm" variant="outline" onClick={() => void copy(stdJson, "Standard JSON input")}>
          Copy standard JSON input
        </Button>
      </div>
      {!rows.length && <p className="mt-3 text-sm text-muted-foreground">No splitter deployed yet.</p>}
      <ul className="mt-3 space-y-3">
        {rows.map((r) => {
          const meta = SPLITTER_CHAINS[r.chain_id as SplitterChainId];
          const args = r.constructor_args.replace(/^0x/, "");
          return (
            <li key={r.id} className="rounded border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1">
                  <b className="font-mono">{short(r.address)}</b> on {meta?.name ?? r.chain_id}
                  <span className="block text-xs text-muted-foreground">Deployed {new Date(r.created_at).toLocaleString()}</span>
                </p>
                {r.is_active ? (
                  <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary">Active</span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void makeActive(r)}>
                    Make active
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Hide" : "Details"}
                </Button>
              </div>
              {open === r.id && (
                <div className="mt-3 space-y-2">
                  <p>
                    <a className="underline" href={`${meta?.explorer}/address/${r.address}#code`} target="_blank" rel="noreferrer">
                      Open on ApeScan ↗
                    </a>{" "}
                    ·{" "}
                    <a className="underline" href={`${meta?.explorer}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">
                      Deployment tx ↗
                    </a>
                  </p>
                  <dl className="grid gap-1 rounded bg-muted/40 p-2 sm:grid-cols-2">
                    <dt className="text-muted-foreground">Contract address</dt>
                    <dd className="break-all font-mono">{r.address}</dd>
                    <dt className="text-muted-foreground">Compiler type</dt>
                    <dd>Solidity (Single file) — or Standard-Json-Input</dd>
                    <dt className="text-muted-foreground">Compiler version</dt>
                    <dd className="font-mono">{COMPILER.label}</dd>
                    <dt className="text-muted-foreground">Open source license</dt>
                    <dd>{COMPILER.license}</dd>
                    <dt className="text-muted-foreground">Optimization</dt>
                    <dd>Yes, {COMPILER.runs} runs</dd>
                    <dt className="text-muted-foreground">EVM version</dt>
                    <dd>{COMPILER.evmVersion}</dd>
                    <dt className="text-muted-foreground">Contract name</dt>
                    <dd className="font-mono">
                      {SPLITTER_FILE}:{SPLITTER_NAME}
                    </dd>
                    <dt className="text-muted-foreground">Owner / keeper</dt>
                    <dd className="font-mono">
                      {short(r.owner)} / {short(r.keeper)}
                    </dd>
                  </dl>
                  <div>
                    <p className="text-muted-foreground">Constructor arguments (ABI-encoded)</p>
                    <p className="break-all font-mono text-xs">{args}</p>
                    <Button className="mt-1" size="sm" variant="outline" onClick={() => void copy(args, "Constructor arguments")}>
                      Copy constructor arguments
                    </Button>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">Recipients</summary>
                    <ul className="mt-1 space-y-0.5">
                      {BUCKETS.map((b, i) => (
                        <li key={b.name} className="font-mono text-xs">
                          {i}. {b.name}: {r.recipients[i]}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
