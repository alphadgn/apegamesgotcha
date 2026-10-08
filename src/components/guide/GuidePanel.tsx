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

type GuideRow = { id: string; role: "user" | "assistant"; parts: UIMessage["parts"] };

const suggestions = [
  "How do I earn points?",
  "How does burning an NFT work?",
  "What prizes can I win?",
  "When and where is ApeFest 2026?",
  "What happens at Charleston?",
];

export function GuidePanel({ compact = false, publicMode = false }: { compact?: boolean; publicMode?: boolean }) {
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
    <main className={compact ? "flex h-full flex-col" : "mx-auto flex h-[calc(100vh-3.5rem)] max-w-3xl flex-col px-4 py-6"}>
      <header className="flex items-center gap-3 pb-4">
        <img src={mascotUrl} alt="Captain Ape, your guide" width={48} height={48} className="rounded-full border border-border bg-card" />
        <div className="flex-1">
          <h1 className="text-xl font-bold">Captain Ape — your guide</h1>
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
