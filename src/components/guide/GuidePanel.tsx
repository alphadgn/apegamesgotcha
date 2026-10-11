import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import mascotUrl from "@/assets/guide-mascot.png";
import { ContactForm } from "./ContactForm";
import { openSignIn } from "@/components/wallet/walletUi";

type GuideRow = { id: string; role: "user" | "assistant"; parts: UIMessage["parts"] };

const suggestions = [
  "How do I earn points?",
  "How does burning an NFT work?",
  "What prizes can I win?",
  "When and where is ApeFest 2026?",
  "What happens at Charleston?",
];

export function GuidePanel({
  compact = false,
  publicMode = false,
  onClose,
}: {
  compact?: boolean;
  publicMode?: boolean;
  /** Closes the panel this guide sits in (before the sign-in window opens). */
  onClose?: () => void;
}) {
  const [initial, setInitial] = useState<UIMessage[] | null>(publicMode ? [] : null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (publicMode) return; // signed-out visitors: general info only, no stored history
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("guide_messages")
        .select("id, role, parts")
        .order("created_at")
        .limit(100);
      if (cancelled) return;
      if (error) {
        toast.error("Couldn't load your conversation");
        setInitial([]);
        return;
      }
      setInitial(
        ((data ?? []) as unknown as GuideRow[]).map((r) => ({ id: r.id, role: r.role, parts: r.parts })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [publicMode]);

  if (publicMode) return <SignedOutGuide compact={compact} onClose={onClose} />;
  if (initial === null) {
    return <main className="mx-auto max-w-3xl px-4 py-12 font-mono text-muted-foreground">Loading…</main>;
  }
  return <GuideChat key="guide" initial={initial} textareaRef={textareaRef} compact={compact} />;
}

function GuideChat({
  initial,
  textareaRef,
  compact,
}: {
  compact: boolean;
  initial: UIMessage[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/guide-chat",
        headers: async () => {
          const { data } = await supabase.auth.getSession();
          return data.session?.access_token
            ? { Authorization: `Bearer ${data.session.access_token}` }
            : {};
        },
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error } = useChat({
    transport,
    messages: initial,
    onError: (e) => toast.error(e.message || "The guide couldn't answer that"),
  });

  const busy = status === "submitted" || status === "streaming";
  const [contact, setContact] = useState(false);

  useEffect(() => {
    if (compact && status === "ready" && messages.length === 0) return;
    textareaRef.current?.focus();
  }, [status, textareaRef]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    void sendMessage({ text: t });
  };

  return (
    <main className={compact ? "flex h-full flex-col" : "mx-auto flex h-[calc(100vh-3.5rem)] h-[calc(100dvh-3.5rem)] max-w-3xl flex-col px-4 py-4 sm:py-6"}>
      <header className={`flex flex-wrap items-center gap-x-3 gap-y-2 pb-3 sm:pb-4 ${compact ? "pr-11" : ""}`}>
        <img src={mascotUrl} alt="Captain Ape, your guide" width={48} height={48} className="h-10 w-10 shrink-0 rounded-full border border-border bg-card sm:h-12 sm:w-12" />
        <div className="min-w-[9rem] flex-1">
          <h1 className="text-lg font-bold sm:text-xl">Captain Ape — your guide</h1>
          <p className="font-mono text-xs text-muted-foreground">Spins, prizes, NFTs, points and Charleston — ask away.</p>
        </div>
        <button type="button" onClick={() => setContact((c) => !c)} className="rounded-full border border-border px-3 py-1 text-xs hover:border-primary hover:text-primary">
          {contact ? "Back to guide" : "Contact us"}
        </button>
      </header>

      {contact && (
        <div className="pb-3">
          <ContactForm onDone={() => setContact(false)} />
        </div>
      )}

      <Conversation className={`flex-1 rounded border border-border bg-card/80 ${contact ? "hidden" : ""}`}>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<img src={mascotUrl} alt="" width={72} height={72} className="rounded-full" />}
              title="Ahoy, player!"
              description="I can explain spins, burning NFTs, points, prizes and the road to Charleston."
            >
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-full border border-border px-3 py-1 font-mono text-xs text-muted-foreground hover:border-primary hover:text-primary"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            messages.map((m, i) => (
              <Message key={m.id} from={m.role}>
                <MessageContent>
                  {m.parts.map((part, j) =>
                    part.type === "text" ? (
                      m.role === "assistant" ? (
                        <MessageResponse key={j}>{part.text}</MessageResponse>
                      ) : (
                        <span key={j}>{part.text}</span>
                      )
                    ) : part.type.startsWith("tool-") && "state" in part && part.state !== "output-available" && part.state !== "output-error" ? (
                      <Shimmer key={j}>Checking boredapeyachtclub.com…</Shimmer>
                    ) : null,
                  )}
                  {busy && m.role === "assistant" && i === messages.length - 1 && !m.parts.some((p) => p.type === "text" && p.text) && (
                    <Shimmer>Thinking…</Shimmer>
                  )}
                </MessageContent>
              </Message>
            ))
          )}
          {status === "submitted" && <Shimmer>Thinking…</Shimmer>}
          {error && <p className="px-2 font-mono text-xs text-destructive">{error.message}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="pt-4">
        <PromptInput onSubmit={(msg) => submit(msg.text)}>
          <PromptInputTextarea ref={textareaRef} placeholder="Ask the guide…" />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} onStop={stop} disabled={!busy && false} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </main>
  );
}

/** Signed out: the guide is a paid AI service, so it asks the visitor to sign in (the Contact form stays open to all). */
function SignedOutGuide({ compact, onClose }: { compact: boolean; onClose?: (() => void) | undefined }) {
  const [contact, setContact] = useState(false);
  return (
    <main className={compact ? "flex h-full flex-col overflow-y-auto" : "mx-auto max-w-3xl px-4 py-8"}>
      <div className="flex flex-col items-center gap-3 rounded border border-border bg-card/80 p-6 text-center">
        <img src={mascotUrl} alt="Captain Ape, your guide" width={72} height={72} className="rounded-full" />
        <h1 className="text-xl font-bold">Captain Ape — your guide</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Sign in to chat with the guide about spins, burning NFTs, points, prizes and ApeFest 2026 in Charleston.
        </p>
        <button
          type="button"
          className="rounded-full bg-primary px-5 py-2 font-bold text-primary-foreground"
          onClick={() => {
            // Close this panel first: a second open window would make Glyph's sign-in cancel.
            onClose?.();
            window.setTimeout(() => openSignIn(), 250);
          }}
        >
          Sign in to chat
        </button>
        <button type="button" onClick={() => setContact((c) => !c)} className="text-xs underline text-muted-foreground">
          {contact ? "Hide the contact form" : "Or send the team a message"}
        </button>
      </div>
      {contact && (
        <div className="pt-3">
          <ContactForm onDone={() => setContact(false)} />
        </div>
      )}
    </main>
  );
}
