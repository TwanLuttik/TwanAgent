import { AnimatePresence, motion } from "motion/react";
import type { AgentTodo, TodoStatus } from "../lib/todo";
import { Symbol } from "./Symbol";

const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.32;

export function TodoSteps({ todos, compact }: { todos: AgentTodo[]; compact?: boolean }) {
  return (
    <div className={`border-b border-line/25 ${compact ? "px-3.5 pt-2.5 pb-2" : "px-4 pt-3 pb-2.5"}`}>
      <ol aria-label="Task list" className="m-0 max-h-[9.5rem] list-none overflow-y-auto p-0">
        <AnimatePresence initial={false}>
          {todos.map((todo, index) => (
            <TodoStep key={todo.id} todo={todo} last={index === todos.length - 1} />
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

function TodoStep({ todo, last }: { todo: AgentTodo; last: boolean }) {
  const done = todo.status === "completed";
  const cancelled = todo.status === "cancelled";
  const active = todo.status === "in_progress";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: DURATION, ease: EASE }}
      aria-current={active ? "step" : undefined}
      className="relative flex items-start gap-2.5"
    >
      <div className="flex w-3.5 shrink-0 flex-col items-center pt-0.5">
        <StatusDot status={todo.status} />
        {!last ? <div className="mt-0.5 w-px min-h-[10px] flex-1 bg-line/45" aria-hidden /> : null}
      </div>
      <p
        className={`min-w-0 flex-1 text-[12px] leading-[18px] ${last ? "pb-0" : "pb-1.5"} ${
          done || cancelled ? "text-muted" : active ? "font-medium text-ink" : "text-ink/80"
        } ${cancelled ? "line-through" : ""}`}
      >
        {todo.content}
      </p>
    </motion.li>
  );
}

function StatusDot({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return (
      <motion.span
        initial={{ scale: 0.72, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: DURATION, ease: EASE }}
        className="flex size-3.5 items-center justify-center text-accent"
        aria-hidden
      >
        <Symbol name="checkmark.circle.fill" className="size-3.5" />
      </motion.span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="flex size-3.5 items-center justify-center" aria-hidden>
        <motion.span
          animate={{ scale: [1, 1.12, 1], opacity: [1, 0.85, 1] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          className="size-2.5 rounded-full border-[1.5px] border-accent bg-accent/25"
        />
      </span>
    );
  }
  return (
    <span className="flex size-3.5 items-center justify-center" aria-hidden>
      <span
        className={`size-2 rounded-full border ${
          status === "cancelled" ? "border-line/70 bg-wash" : "border-line bg-panel"
        }`}
      />
    </span>
  );
}
