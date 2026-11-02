"use client";

import { ArrowUp } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../_ui/cn";

/** Enter sends, Shift+Enter breaks the line; Enter that confirms an IME candidate never sends. */
export function Composer({
  onSend,
  disabled = false,
  placeholder = "说说你想怎么过这一天…",
  initial = "",
  autoFocus = false,
  suggestion = null,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  initial?: string;
  autoFocus?: boolean;
  /** V2.6: a message put in the box for the user to read and send (a new `nonce` replaces it). */
  suggestion?: { text: string; nonce: number } | null;
}) {
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const [shown, setShown] = useState<number | null>(null);
  if (suggestion && suggestion.nonce !== shown) {
    setShown(suggestion.nonce);
    setText(suggestion.text);
  }
  useEffect(() => {
    if (suggestion) area.current?.focus();
  }, [suggestion]);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [text]);

  function send() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  }

  return (
    <div
      className={cn(
        "flex items-end gap-2 rounded-[26px] border border-line bg-surface p-2 pl-4 shadow-card",
        "transition-shadow focus-within:border-lake-200 focus-within:shadow-float",
      )}
    >
      <textarea
        id="chat-composer"
        ref={area}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        maxLength={1000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="输入消息"
        className="max-h-[180px] min-h-10 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 outline-none placeholder:text-ink-faint"
      />
      <button
        type="button"
        onClick={send}
        disabled={disabled || !text.trim()}
        aria-label="发送"
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-full bg-lake-600 text-white transition-[background-color,transform]",
          "hover:bg-lake-700 active:scale-95 disabled:bg-line-strong",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
        )}
      >
        <ArrowUp className="size-5" />
      </button>
    </div>
  );
}
